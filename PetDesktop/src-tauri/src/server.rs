use std::{
    net::{IpAddr, SocketAddr},
    str::FromStr,
};

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::{TcpListener, UdpSocket};

use crate::{
    core::{AppCore, RegisterAgent},
    model::{AgentState, LogLevel, APP_VERSION, HTTP_PORT, UDP_PORT},
};

type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug)]
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "ok": false, "error": self.1 }))).into_response()
    }
}

#[derive(Debug, Deserialize)]
struct AgentQuery {
    state: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest {
    instance_id: String,
    client_id: String,
    display_name: Option<String>,
    version: Option<String>,
    state: Option<AgentState>,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateRequest {
    state: AgentState,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionRequest {
    instance_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OkResponse {
    ok: bool,
}

pub fn start(core: AppCore) {
    let http_core = core.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve_http(http_core.clone()).await {
            http_core.log(LogLevel::Error, "http", error);
        }
    });

    let udp_core = core;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve_udp(udp_core.clone()).await {
            udp_core.log(LogLevel::Error, "udp", error);
        }
    });
}

async fn serve_http(core: AppCore) -> Result<(), String> {
    let router = Router::new()
        .route("/health", get(health))
        .route("/api/state", get(api_state))
        .route("/api/agent", post(api_agent))
        .route("/api/cmd", post(api_command))
        .route("/api/v1/agents/register", post(register_agent))
        .route("/api/v1/agents", get(list_agents))
        .route("/api/v1/agents/selection", put(select_agent))
        .route("/api/v1/agents/{instance_id}/heartbeat", post(heartbeat))
        .route("/api/v1/agents/{instance_id}/state", post(v1_state))
        .route("/api/v1/agents/{instance_id}", delete(disconnect_agent))
        .with_state(core.clone());

    let ip = if core.settings().lan_enabled {
        IpAddr::from([0, 0, 0, 0])
    } else {
        IpAddr::from([127, 0, 0, 1])
    };
    let address = SocketAddr::new(ip, HTTP_PORT);
    let listener = TcpListener::bind(address)
        .await
        .map_err(|error| format!("cannot listen on http://{address}: {error}"))?;
    core.log(
        LogLevel::Info,
        "http",
        format!("listening on http://{address}"),
    );
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .map_err(|error| format!("HTTP server stopped: {error}"))
}

async fn health(State(core): State<AppCore>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "device": "PetDesktop",
        "model": "AgentAura-PetDesktop",
        "version": APP_VERSION,
        "state": core.snapshot().effective_state,
    }))
}

async fn api_state(
    State(core): State<AppCore>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    authorize(&core, &headers, remote)?;
    Ok(Json(device_state(&core)))
}

async fn api_agent(
    State(core): State<AppCore>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
) -> ApiResult<String> {
    authorize(&core, &headers, remote)?;
    let state = AgentState::from_str(&query.state).map_err(bad_request)?;
    let identity = identity_from_headers(&headers);
    core.submit_state(
        &identity.instance_id,
        &identity.client_id,
        &identity.display_name,
        state,
        identity.session_id,
    );
    Ok(format!("OK agent {}", state.as_str()))
}

async fn api_command(
    State(core): State<AppCore>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    authorize(&core, &headers, remote)?;
    if body.len() > 8_192 {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "command body exceeds 8 KiB".into(),
        ));
    }
    let command = std::str::from_utf8(&body)
        .map_err(|_| bad_request("command must be UTF-8"))?
        .trim();
    if command.eq_ignore_ascii_case("state") {
        return Ok(Json(device_state(&core)).into_response());
    }
    if let Some(value) = command.strip_prefix("agent ") {
        let state = AgentState::from_str(value).map_err(bad_request)?;
        let identity = identity_from_headers(&headers);
        core.submit_state(
            &identity.instance_id,
            &identity.client_id,
            &identity.display_name,
            state,
            identity.session_id,
        );
        return Ok(format!("OK agent {}", state.as_str()).into_response());
    }
    if !is_firmware_command(command) {
        return Err(bad_request("unsupported command"));
    }
    core.forward_command(command.to_string())
        .await
        .map(IntoResponse::into_response)
        .map_err(|error| ApiError(StatusCode::SERVICE_UNAVAILABLE, error))
}

async fn register_agent(
    State(core): State<AppCore>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<RegisterRequest>,
) -> ApiResult<Json<Value>> {
    authorize(&core, &headers, remote)?;
    validate_identity(&request.client_id, &request.instance_id)?;
    let instance_id = request.instance_id;
    core.register_agent(RegisterAgent {
        instance_id: instance_id.clone(),
        display_name: request
            .display_name
            .unwrap_or_else(|| request.client_id.clone()),
        client_id: request.client_id,
        version: request.version,
        state: request.state.unwrap_or(AgentState::Init),
        session_id: request.session_id,
    });
    Ok(Json(
        json!({ "ok": true, "instanceId": instance_id, "heartbeatIntervalMs": 10_000 }),
    ))
}

async fn heartbeat(
    State(core): State<AppCore>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(instance_id): Path<String>,
) -> ApiResult<Json<OkResponse>> {
    authorize(&core, &headers, remote)?;
    core.heartbeat(&instance_id)
        .map_err(|error| ApiError(StatusCode::NOT_FOUND, error))?;
    Ok(Json(OkResponse { ok: true }))
}

async fn v1_state(
    State(core): State<AppCore>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(instance_id): Path<String>,
    Json(request): Json<StateRequest>,
) -> ApiResult<Json<Value>> {
    authorize(&core, &headers, remote)?;
    let identity = identity_from_headers(&headers);
    core.submit_state(
        &instance_id,
        &identity.client_id,
        &identity.display_name,
        request.state,
        request.session_id,
    );
    Ok(Json(json!({ "ok": true, "state": request.state })))
}

async fn disconnect_agent(
    State(core): State<AppCore>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(instance_id): Path<String>,
) -> ApiResult<Json<OkResponse>> {
    authorize(&core, &headers, remote)?;
    core.disconnect_agent(&instance_id)
        .map_err(|error| ApiError(StatusCode::NOT_FOUND, error))?;
    Ok(Json(OkResponse { ok: true }))
}

async fn list_agents(
    State(core): State<AppCore>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    authorize(&core, &headers, remote)?;
    let snapshot = core.snapshot();
    Ok(Json(json!({
        "ok": true,
        "agents": snapshot.agents,
        "effectiveState": snapshot.effective_state,
        "effectiveAgentId": snapshot.effective_agent_id,
        "lockedAgentId": snapshot.locked_agent_id,
    })))
}

async fn select_agent(
    State(core): State<AppCore>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<SelectionRequest>,
) -> ApiResult<Json<OkResponse>> {
    authorize(&core, &headers, remote)?;
    core.set_locked_agent(request.instance_id)
        .map_err(bad_request)?;
    Ok(Json(OkResponse { ok: true }))
}

fn device_state(core: &AppCore) -> Value {
    let snapshot = core.snapshot();
    json!({
        "device": "PetDesktop",
        "model": "AgentAura-PetDesktop",
        "firmware": APP_VERSION,
        "uptime": 0,
        "wifi": {
            "connected": snapshot.settings.lan_enabled,
            "ip": if snapshot.settings.lan_enabled { "0.0.0.0" } else { "127.0.0.1" },
            "mode": if snapshot.settings.lan_enabled { "LAN" } else { "loopback" }
        },
        "led": {
            "power": snapshot.settings.pet_visible,
            "brightness": 255,
            "speed": snapshot.settings.roam_speed
        },
        "current": {
            "effect": snapshot.effective_state.as_str(),
            "agentState": snapshot.effective_state,
            "agentId": snapshot.effective_agent_id
        },
        "connections": {
            "http": true,
            "udp": true,
            "serial": false,
            "hardware": snapshot.hardware.connected
        },
        "pet": snapshot.selected_pet,
        "agents": snapshot.agents.len()
    })
}

async fn serve_udp(core: AppCore) -> Result<(), String> {
    // Legacy plugins discover hardware via UDP broadcast, so the desktop app
    // needs to receive discovery datagrams on all interfaces even when HTTP
    // stays loopback-only.
    let bind = format!("0.0.0.0:{UDP_PORT}");
    let socket = UdpSocket::bind(&bind)
        .await
        .map_err(|error| format!("cannot listen on udp://{bind}: {error}"))?;
    core.log(LogLevel::Info, "udp", format!("listening on udp://{bind}"));
    let mut buffer = [0_u8; 8_192];
    loop {
        let (size, remote) = socket
            .recv_from(&mut buffer)
            .await
            .map_err(|error| format!("UDP receive failed: {error}"))?;
        let raw = String::from_utf8_lossy(&buffer[..size]).trim().to_string();
        let response = udp_command(&core, remote, &raw).await;
        let _ = socket.send_to(response.as_bytes(), remote).await;
    }
}

async fn udp_command(core: &AppCore, remote: SocketAddr, raw: &str) -> String {
    let is_discovery = matches!(
        raw.to_ascii_lowercase().as_str(),
        "discover" | "ping" | "who"
    );
    let command = if remote.ip().is_loopback() || is_discovery {
        raw
    } else {
        let Some(rest) = raw.strip_prefix("auth ") else {
            return "ERR unauthorized".to_string();
        };
        let Some((token, command)) = rest.split_once(' ') else {
            return "ERR unauthorized".to_string();
        };
        if !core.settings().lan_enabled || token != core.settings().lan_token {
            return "ERR unauthorized".to_string();
        }
        command
    };

    match command.to_ascii_lowercase().as_str() {
        "discover" | "ping" | "who" => serde_json::to_string(&discovery_response(core, remote))
            .unwrap_or_else(|_| "ERR serialization".into()),
        "state" => serde_json::to_string(&device_state(core))
            .unwrap_or_else(|_| "ERR serialization".into()),
        _ => {
            if let Some(value) = command.strip_prefix("agent ") {
                match AgentState::from_str(value) {
                    Ok(state) => {
                        core.submit_state("legacy-udp", "legacy", "Legacy UDP", state, None);
                        format!("OK agent {}", state.as_str())
                    }
                    Err(error) => format!("ERR {error}"),
                }
            } else if is_firmware_command(command) {
                core.forward_command(command.to_string())
                    .await
                    .unwrap_or_else(|error| format!("ERR {error}"))
            } else {
                "ERR unsupported command".to_string()
            }
        }
    }
}

fn discovery_response(core: &AppCore, _remote: SocketAddr) -> Value {
    // Legacy plugins persist the reported IP and then switch to HTTP, so we
    // advertise the loopback listener rather than the UDP source interface.
    let ip = "127.0.0.1";
    json!({
        "id": "petdesktop-local",
        "mac": "petdesktop-local",
        "device": "PetDesktop",
        "model": "AgentAura-PetDesktop",
        "fw": APP_VERSION,
        "ip": ip,
        "udp": UDP_PORT,
        "http": HTTP_PORT,
        "effect": core.snapshot().effective_state,
        "caps": ["legacy-http", "legacy-udp", "agent-v1", "local-desktop"]
    })
}

fn authorize(core: &AppCore, headers: &HeaderMap, remote: SocketAddr) -> ApiResult<()> {
    if let Some(origin) = header(headers, "origin") {
        let trusted = origin == "tauri://localhost"
            || origin == "http://tauri.localhost"
            || origin == "https://tauri.localhost"
            || origin == "http://localhost:1420";
        if !trusted {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "untrusted browser origin".into(),
            ));
        }
    }
    if remote.ip().is_loopback() {
        return Ok(());
    }
    let settings = core.settings();
    if !settings.lan_enabled {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "LAN access is disabled".into(),
        ));
    }
    let expected = format!("Bearer {}", settings.lan_token);
    if header(headers, "authorization").as_deref() != Some(expected.as_str()) {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "missing or invalid bearer token".into(),
        ));
    }
    Ok(())
}

struct Identity {
    instance_id: String,
    client_id: String,
    display_name: String,
    session_id: Option<String>,
}

fn identity_from_headers(headers: &HeaderMap) -> Identity {
    let client_id = header(headers, "x-agentaura-client").unwrap_or_else(|| "legacy".into());
    Identity {
        instance_id: header(headers, "x-agentaura-instance")
            .unwrap_or_else(|| "legacy-http".into()),
        display_name: header(headers, "x-agentaura-name").unwrap_or_else(|| client_id.clone()),
        session_id: header(headers, "x-agentaura-session"),
        client_id,
    }
}

fn validate_identity(client_id: &str, instance_id: &str) -> ApiResult<()> {
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_.:".contains(character))
    };
    if !valid(client_id) || !valid(instance_id) {
        return Err(bad_request(
            "clientId and instanceId must use 1-128 safe identifier characters",
        ));
    }
    Ok(())
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name)?.to_str().ok().map(ToOwned::to_owned)
}

fn is_firmware_command(command: &str) -> bool {
    let first = command
        .split_ascii_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        first.as_str(),
        "rgb" | "effect" | "brightness" | "brt" | "speed" | "spd" | "power" | "reset"
    )
}

fn bad_request(error: impl ToString) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::AppCore;
    use tempfile::tempdir;

    #[test]
    fn firmware_command_allowlist_rejects_configuration_commands() {
        assert!(is_firmware_command("rgb 1,2,3"));
        assert!(is_firmware_command("effect breath 1,2,3"));
        assert!(!is_firmware_command("factory"));
        assert!(!is_firmware_command("wifi ssid,password"));
    }

    #[test]
    fn discovery_response_exposes_stable_desktop_identity() {
        let dir = tempdir().unwrap();
        let core = AppCore::new(dir.path().to_path_buf()).unwrap();
        let response = discovery_response(&core, SocketAddr::from(([192, 168, 1, 8], 45678)));
        assert_eq!(response["device"], "PetDesktop");
        assert_eq!(response["mac"], "petdesktop-local");
        assert_eq!(response["ip"], "127.0.0.1");
        assert_eq!(response["http"], HTTP_PORT);
        assert_eq!(response["udp"], UDP_PORT);
        assert!(response["caps"]
            .as_array()
            .is_some_and(|caps| caps.iter().any(|value| value == "agent-v1")));
    }
}
