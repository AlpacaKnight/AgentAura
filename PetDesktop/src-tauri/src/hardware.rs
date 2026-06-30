use std::{
    io::{Read, Write},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
    net::UdpSocket,
    sync::{mpsc, oneshot},
};

use crate::{
    core::{now_iso, AppCore},
    model::{AgentState, HardwareConfig, HardwareTransport, LogLevel, UDP_PORT},
};

pub enum HardwareMessage {
    State(AgentState),
    Command(String, oneshot::Sender<Result<String, String>>),
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

pub fn start_worker(core: AppCore) -> mpsc::Sender<HardwareMessage> {
    let (sender, mut receiver) = mpsc::channel::<HardwareMessage>(64);
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(1_500))
            .no_proxy()
            .build()
            .expect("reqwest client");
        while let Some(message) = receiver.recv().await {
            let command = match &message {
                HardwareMessage::State(state) => format!("agent {}", state.as_str()),
                HardwareMessage::Command(command, _) => command.clone(),
            };
            let mut status = core.hardware_status();
            status.syncing = true;
            core.update_hardware(status);

            let config = core.settings().hardware;
            let result = send_command(&client, &config, &command).await;
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

pub async fn send_command(
    client: &reqwest::Client,
    config: &HardwareConfig,
    command: &str,
) -> Result<String, String> {
    match config.transport {
        HardwareTransport::Disabled => Err("hardware bridge is disabled".to_string()),
        HardwareTransport::Http => send_http(client, config, command).await,
        HardwareTransport::Udp => send_udp(config, command).await,
        HardwareTransport::Serial => send_serial(config.clone(), command.to_string()).await,
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
    socket
        .send_to(b"discover\n", format!("255.255.255.255:{UDP_PORT}"))
        .await
        .map_err(|error| format!("cannot send discovery broadcast: {error}"))?;

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
            port_type: format!("{:?}", port.port_type),
        })
        .collect())
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
}
