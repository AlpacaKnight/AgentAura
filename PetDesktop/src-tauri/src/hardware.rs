use std::{
    io::{Read, Write},
    time::Duration,
};

use btleplug::{
    api::{
        Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter,
        WriteType,
    },
    platform::{Adapter, Manager, Peripheral},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::{
    net::UdpSocket,
    sync::{mpsc, oneshot},
};

use crate::{
    core::{now_iso, AppCore},
    model::{AgentState, HardwareConfig, HardwareTransport, LogLevel, UDP_PORT},
};

const BLE_SERVICE_UUID: &str = "8e7f1a01-2b3c-4d5e-9f01-a1b2c3d4e5f0";
const BLE_CMD_UUID: &str = "8e7f1a02-2b3c-4d5e-9f01-a1b2c3d4e5f0";
const BLE_STATE_UUID: &str = "8e7f1a03-2b3c-4d5e-9f01-a1b2c3d4e5f0";

pub enum HardwareMessage {
    State(AgentState),
    PetMessage(String),
    Command(String, oneshot::Sender<Result<String, String>>),
    Disconnect(oneshot::Sender<()>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHardware {
    pub device: Option<String>,
    pub model: Option<String>,
    pub fw: Option<String>,
    pub ip: String,
    pub http: Option<u16>,
    pub udp: Option<u16>,
    pub mac: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub name: String,
    pub port_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BleDeviceInfo {
    pub name: String,
    pub address: String,
    pub rssi: Option<i16>,
}

pub fn start_worker(core: AppCore) -> mpsc::Sender<HardwareMessage> {
    let (sender, mut receiver) = mpsc::channel::<HardwareMessage>(64);
    tauri::async_runtime::spawn(async move {
        let mut ble_session = None;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(1_500))
            .no_proxy()
            .build()
            .expect("reqwest client");
        while let Some(message) = receiver.recv().await {
            if let HardwareMessage::Disconnect(responder) = message {
                disconnect_ble_session(&mut ble_session).await;
                let mut status = core.hardware_status();
                status.connected = false;
                status.syncing = false;
                status.last_error = None;
                status.device = None;
                core.update_hardware(status);
                let _ = responder.send(());
                continue;
            }

            let command = match &message {
                HardwareMessage::State(state) => format!("agent {}", state.as_str()),
                HardwareMessage::PetMessage(text) => {
                    format!("pet speak {}", hardware_message_text(text))
                }
                HardwareMessage::Command(command, _) => command.clone(),
                HardwareMessage::Disconnect(_) => unreachable!(),
            };
            let mut status = core.hardware_status();
            status.syncing = true;
            core.update_hardware(status);

            let config = core.settings().hardware;
            if config.transport != HardwareTransport::Ble {
                disconnect_ble_session(&mut ble_session).await;
            }
            let result =
                send_command_with_ble_session(&client, &config, &command, &mut ble_session).await;
            let mut status = core.hardware_status();
            status.syncing = false;
            match &result {
                Ok(response) => {
                    status.connected = config.transport != HardwareTransport::Disabled;
                    status.last_success_at = Some(now_iso());
                    status.last_error = None;
                    if response.trim_start().starts_with('{') {
                        status.device = serde_json::from_str(response).ok();
                    }
                }
                Err(error) => {
                    status.connected = false;
                    status.last_error = Some(error.clone());
                }
            }
            core.update_hardware(status);

            if let HardwareMessage::Command(_, responder) = message {
                let _ = responder.send(result);
            } else if let Err(error) = result {
                core.log(LogLevel::Warn, "hardware", error);
            }
        }
    });
    sender
}

#[cfg(test)]
async fn send_command(
    client: &reqwest::Client,
    config: &HardwareConfig,
    command: &str,
) -> Result<String, String> {
    let mut ble_session = None;
    let result = send_command_with_ble_session(client, config, command, &mut ble_session).await;
    disconnect_ble_session(&mut ble_session).await;
    result
}

async fn send_command_with_ble_session(
    client: &reqwest::Client,
    config: &HardwareConfig,
    command: &str,
    ble_session: &mut Option<BleSession>,
) -> Result<String, String> {
    match config.transport {
        HardwareTransport::Disabled => Err("hardware bridge is disabled".to_string()),
        HardwareTransport::Http => send_http(client, config, command).await,
        HardwareTransport::Udp => send_udp(config, command).await,
        HardwareTransport::Serial => send_serial(config.clone(), command.to_string()).await,
        HardwareTransport::Ble => send_ble(config, command, ble_session).await,
    }
}

async fn ble_adapter() -> Result<Adapter, String> {
    let manager = Manager::new()
        .await
        .map_err(|error| format!("cannot initialize Bluetooth manager: {error}"))?;
    manager
        .adapters()
        .await
        .map_err(|error| format!("cannot list Bluetooth adapters: {error}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "no Bluetooth adapter is available".to_string())
}

async fn scan_ble_peripherals(duration: Duration) -> Result<Vec<Peripheral>, String> {
    let adapter = ble_adapter().await?;
    let service = uuid::Uuid::parse_str(BLE_SERVICE_UUID)
        .map_err(|error| format!("invalid BLE service UUID: {error}"))?;
    adapter
        .start_scan(ScanFilter {
            services: vec![service],
        })
        .await
        .map_err(|error| format!("cannot start BLE scan: {error}"))?;
    tokio::time::sleep(duration).await;
    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|error| format!("cannot read BLE scan results: {error}"))?;
    let _ = adapter.stop_scan().await;
    Ok(peripherals)
}

pub async fn ble_devices() -> Result<Vec<BleDeviceInfo>, String> {
    let mut devices = Vec::new();
    for peripheral in scan_ble_peripherals(Duration::from_secs(3)).await? {
        let Some(properties) = peripheral
            .properties()
            .await
            .map_err(|error| format!("cannot read BLE device properties: {error}"))?
        else {
            continue;
        };
        let address = properties.address.to_string();
        let name = properties
            .local_name
            .unwrap_or_else(|| format!("AgentAura ({address})"));
        devices.push(BleDeviceInfo {
            name,
            address,
            rssi: properties.rssi,
        });
    }
    devices.sort_by(|left, right| right.rssi.cmp(&left.rssi));
    Ok(devices)
}

struct BleSession {
    address: String,
    peripheral: Peripheral,
    cmd_characteristic: Characteristic,
    state_characteristic: Characteristic,
}

impl BleSession {
    async fn send(&self, command: &str) -> Result<String, String> {
        if !self
            .peripheral
            .is_connected()
            .await
            .map_err(|error| format!("cannot read BLE connection state: {error}"))?
        {
            return Err("BLE device disconnected".to_string());
        }

        let mut notifications = self
            .peripheral
            .notifications()
            .await
            .map_err(|error| format!("cannot open BLE notification stream: {error}"))?;
        let payload = format!("{command}\n");
        let write_type = if self
            .cmd_characteristic
            .properties
            .contains(CharPropFlags::WRITE)
        {
            WriteType::WithResponse
        } else {
            WriteType::WithoutResponse
        };
        self.peripheral
            .write(&self.cmd_characteristic, payload.as_bytes(), write_type)
            .await
            .map_err(|error| format!("cannot write BLE command: {error}"))?;

        let first = tokio::time::timeout(Duration::from_secs(3), notifications.next())
            .await
            .map_err(|_| "BLE hardware response timed out".to_string())?
            .ok_or_else(|| "BLE notification stream closed".to_string())?;
        let mut response = first.value;
        loop {
            match tokio::time::timeout(Duration::from_millis(150), notifications.next()).await {
                Ok(Some(notification)) => response.extend(notification.value),
                _ => break,
            }
        }
        let response = String::from_utf8_lossy(&response).trim().to_string();
        if response.is_empty() {
            Err("BLE hardware returned no response".to_string())
        } else if response
            .lines()
            .any(|line| line.trim_start().starts_with("ERR"))
        {
            Err(response)
        } else {
            Ok(response)
        }
    }
}

async fn connect_ble(config: &HardwareConfig) -> Result<BleSession, String> {
    let peripherals = scan_ble_peripherals(Duration::from_millis(1_500)).await?;
    let target = if config.ble_address.trim().is_empty() {
        peripherals.into_iter().next()
    } else {
        peripherals.into_iter().find(|peripheral| {
            peripheral
                .address()
                .to_string()
                .eq_ignore_ascii_case(config.ble_address.trim())
        })
    }
    .ok_or_else(|| {
        if config.ble_address.trim().is_empty() {
            "no AgentAura BLE device was found".to_string()
        } else {
            format!("BLE device {} was not found", config.ble_address.trim())
        }
    })?;

    target
        .connect()
        .await
        .map_err(|error| format!("cannot connect to BLE device: {error}"))?;
    let result = async {
        target
            .discover_services()
            .await
            .map_err(|error| format!("cannot discover BLE services: {error}"))?;
        let cmd_uuid = uuid::Uuid::parse_str(BLE_CMD_UUID).map_err(|error| error.to_string())?;
        let state_uuid =
            uuid::Uuid::parse_str(BLE_STATE_UUID).map_err(|error| error.to_string())?;
        let characteristics = target.characteristics();
        let cmd_characteristic = characteristics
            .iter()
            .find(|entry| {
                entry.uuid == cmd_uuid
                    && entry
                        .properties
                        .intersects(CharPropFlags::WRITE | CharPropFlags::WRITE_WITHOUT_RESPONSE)
            })
            .cloned()
            .ok_or_else(|| "AgentAura BLE command characteristic is missing".to_string())?;
        let state_characteristic = characteristics
            .iter()
            .find(|entry| {
                entry.uuid == state_uuid && entry.properties.contains(CharPropFlags::NOTIFY)
            })
            .cloned()
            .ok_or_else(|| "AgentAura BLE state characteristic is missing".to_string())?;

        target
            .subscribe(&state_characteristic)
            .await
            .map_err(|error| format!("cannot subscribe to BLE responses: {error}"))?;
        Ok(BleSession {
            address: target.address().to_string(),
            peripheral: target.clone(),
            cmd_characteristic,
            state_characteristic,
        })
    }
    .await;
    if result.is_err() {
        let _ = target.disconnect().await;
    }
    result
}

async fn send_ble(
    config: &HardwareConfig,
    command: &str,
    session: &mut Option<BleSession>,
) -> Result<String, String> {
    let configured_address = config.ble_address.trim();
    if let Some(existing) = session {
        let address_changed = !configured_address.is_empty()
            && !existing.address.eq_ignore_ascii_case(configured_address);
        let connected = existing.peripheral.is_connected().await.unwrap_or(false);
        if address_changed || !connected {
            disconnect_ble_session(session).await;
        }
    }

    let mut first_error = None;
    for _ in 0..2 {
        if session.is_none() {
            match connect_ble(config).await {
                Ok(connected) => *session = Some(connected),
                Err(error) => {
                    first_error.get_or_insert(error);
                    continue;
                }
            }
        }

        let result = session
            .as_ref()
            .expect("BLE session was initialized")
            .send(command)
            .await;
        match result {
            Ok(response) => return Ok(response),
            Err(error) => {
                first_error.get_or_insert(error);
                disconnect_ble_session(session).await;
            }
        }
    }

    Err(first_error.unwrap_or_else(|| "cannot establish BLE connection".to_string()))
}

async fn disconnect_ble_session(session: &mut Option<BleSession>) {
    if let Some(existing) = session.take() {
        let _ = existing
            .peripheral
            .unsubscribe(&existing.state_characteristic)
            .await;
        let _ = existing.peripheral.disconnect().await;
    }
}

async fn send_http(
    client: &reqwest::Client,
    config: &HardwareConfig,
    command: &str,
) -> Result<String, String> {
    if config.host.trim().is_empty() {
        return Err("hardware HTTP host is empty".to_string());
    }
    let base = format!("http://{}:{}", config.host.trim(), config.port);
    let response = if let Some(state) = command.strip_prefix("agent ") {
        client
            .post(format!("{base}/api/agent"))
            .query(&[("state", state.trim())])
            .send()
            .await
    } else {
        client
            .post(format!("{base}/api/cmd"))
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body(command.to_string())
            .send()
            .await
    }
    .map_err(|error| format!("HTTP hardware request failed: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("cannot read HTTP hardware response: {error}"))?;
    if status.is_success() {
        Ok(body)
    } else {
        Err(format!("HTTP hardware returned {status}: {}", body.trim()))
    }
}

async fn send_udp(config: &HardwareConfig, command: &str) -> Result<String, String> {
    if config.host.trim().is_empty() {
        return Err("hardware UDP host is empty".to_string());
    }
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|error| format!("cannot open UDP socket: {error}"))?;
    let destination = format!("{}:{}", config.host.trim(), config.port);
    socket
        .send_to(format!("{command}\n").as_bytes(), &destination)
        .await
        .map_err(|error| format!("cannot send UDP hardware command: {error}"))?;
    let mut buffer = [0_u8; 4_096];
    let (size, _) =
        tokio::time::timeout(Duration::from_millis(1_200), socket.recv_from(&mut buffer))
            .await
            .map_err(|_| "UDP hardware response timed out".to_string())?
            .map_err(|error| format!("cannot receive UDP hardware response: {error}"))?;
    let response = String::from_utf8_lossy(&buffer[..size]).trim().to_string();
    if response.starts_with("ERR") {
        Err(response)
    } else {
        Ok(response)
    }
}

async fn send_serial(config: HardwareConfig, command: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if config.serial_port.trim().is_empty() {
            return Err("hardware serial port is empty".to_string());
        }
        let mut port = serialport::new(&config.serial_port, config.baud)
            .timeout(Duration::from_millis(1_200))
            .open()
            .map_err(|error| format!("cannot open serial port {}: {error}", config.serial_port))?;
        port.write_all(format!("{command}\n").as_bytes())
            .map_err(|error| format!("cannot write serial command: {error}"))?;
        let mut buffer = Vec::with_capacity(4_096);
        let mut byte = [0_u8; 1];
        loop {
            match port.read(&mut byte) {
                Ok(0) => break,
                Ok(_) => {
                    buffer.push(byte[0]);
                    if byte[0] == b'\n' || buffer.len() >= 4_096 {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => break,
                Err(error) => return Err(format!("cannot read serial response: {error}")),
            }
        }
        let response = String::from_utf8_lossy(&buffer).trim().to_string();
        if response.is_empty() {
            Err("serial hardware returned no response".to_string())
        } else if response.starts_with("ERR") {
            Err(response)
        } else {
            Ok(response)
        }
    })
    .await
    .map_err(|error| format!("serial worker failed: {error}"))?
}

pub async fn discover() -> Result<Vec<DiscoveredHardware>, String> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|error| format!("cannot bind discovery socket: {error}"))?;
    socket
        .set_broadcast(true)
        .map_err(|error| format!("cannot enable UDP broadcast: {error}"))?;
    let mut broadcasts = std::collections::HashSet::from([std::net::Ipv4Addr::BROADCAST]);
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            if let if_addrs::IfAddr::V4(address) = interface.addr {
                if address.ip.is_loopback() {
                    continue;
                }
                let ip = u32::from(address.ip);
                let mask = u32::from(address.netmask);
                broadcasts.insert(std::net::Ipv4Addr::from(ip | !mask));
            }
        }
    }
    let mut sent = false;
    for broadcast in broadcasts {
        if socket
            .send_to(b"discover\n", (broadcast, UDP_PORT))
            .await
            .is_ok()
        {
            sent = true;
        }
    }
    if !sent {
        return Err("cannot send discovery broadcast on any network adapter".to_string());
    }

    let deadline = tokio::time::Instant::now() + Duration::from_millis(1_500);
    let mut devices = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut buffer = [0_u8; 4_096];
    loop {
        let received = tokio::time::timeout_at(deadline, socket.recv_from(&mut buffer)).await;
        let Ok(Ok((size, remote))) = received else {
            break;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buffer[..size]) else {
            continue;
        };
        if value.get("device").and_then(|entry| entry.as_str()) == Some("PetDesktop") {
            continue;
        }
        let ip = value
            .get("ip")
            .and_then(|entry| entry.as_str())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| remote.ip().to_string());
        let mac = value
            .get("mac")
            .and_then(|entry| entry.as_str())
            .map(ToOwned::to_owned);
        let key = mac.clone().unwrap_or_else(|| ip.clone());
        if !seen.insert(key) {
            continue;
        }
        devices.push(DiscoveredHardware {
            device: json_string(&value, "device"),
            model: json_string(&value, "model"),
            fw: json_string(&value, "fw").or_else(|| json_string(&value, "firmware")),
            ip,
            http: json_u16(&value, "http"),
            udp: json_u16(&value, "udp"),
            mac,
        });
    }
    Ok(devices)
}

pub fn serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports()
        .map_err(|error| format!("cannot list serial ports: {error}"))?;
    Ok(ports
        .into_iter()
        .map(|port| SerialPortInfo {
            name: port.port_name,
            port_type: format_port_type(&port.port_type),
        })
        .collect())
}

/// 将串口类型枚举转换为简洁的可读标签，避免 `{:?}` 输出的冗长调试信息。
fn format_port_type(port_type: &serialport::SerialPortType) -> String {
    match port_type {
        serialport::SerialPortType::UsbPort(info) => {
            let vid = info.vid;
            let pid = info.pid;
            if let Some(product) = &info.product {
                format!("USB · {product} ({vid:04x}:{pid:04x})")
            } else if let Some(manufacturer) = &info.manufacturer {
                format!("USB · {manufacturer} ({vid:04x}:{pid:04x})")
            } else {
                format!("USB ({vid:04x}:{pid:04x})")
            }
        }
        serialport::SerialPortType::PciPort => "PCI".to_string(),
        serialport::SerialPortType::BluetoothPort => "Bluetooth".to_string(),
        serialport::SerialPortType::Unknown => "Unknown".to_string(),
    }
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|entry| entry.as_str())
        .map(ToOwned::to_owned)
}

fn json_u16(value: &serde_json::Value, key: &str) -> Option<u16> {
    value
        .get(key)
        .and_then(|entry| entry.as_u64())
        .and_then(|entry| u16::try_from(entry).ok())
}

fn hardware_message_text(text: &str) -> String {
    let normalized = text
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut result = String::new();
    for ch in normalized.chars() {
        if result.len() + ch.len_utf8() > 180 {
            break;
        }
        result.push(ch);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disabled_transport_returns_a_clear_error() {
        let client = reqwest::Client::new();
        let error = send_command(&client, &HardwareConfig::default(), "agent busy")
            .await
            .unwrap_err();
        assert!(error.contains("disabled"));
    }

    #[tokio::test]
    async fn live_ble_transport_round_trip_when_requested() {
        let Ok(address) = std::env::var("AGENTAURA_TEST_BLE_ADDRESS") else {
            return;
        };
        let client = reqwest::Client::new();
        let mut config = HardwareConfig::default();
        config.transport = HardwareTransport::Ble;
        config.ble_address = address;
        let mut session = None;
        let response = send_command_with_ble_session(&client, &config, "state", &mut session)
            .await
            .unwrap();
        let payload = response
            .split_once('\n')
            .map(|(_, payload)| payload)
            .unwrap_or(&response);
        let state: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(state["device"], "ESP32-C6-AMOLED-PET");
        assert!(session.is_some());

        let second = send_command_with_ble_session(&client, &config, "state", &mut session)
            .await
            .unwrap();
        assert!(second.contains("ESP32-C6-AMOLED-PET"));
        assert!(session
            .as_ref()
            .unwrap()
            .peripheral
            .is_connected()
            .await
            .unwrap());
        disconnect_ble_session(&mut session).await;
    }

    #[test]
    fn hardware_pet_message_is_single_line_and_bounded() {
        let text = format!("第一行\n第二行 {}", "字".repeat(100));
        let result = hardware_message_text(&text);
        assert!(!result.contains('\n'));
        assert!(result.len() <= 180);
        assert!(result.is_char_boundary(result.len()));
        assert!(result.starts_with("第一行 第二行"));
    }
}
