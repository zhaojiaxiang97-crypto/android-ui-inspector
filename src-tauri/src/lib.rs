use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use quick_xml::{
    events::{BytesStart, Event},
    reader::Reader,
    XmlVersion,
};
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo {
    serial: String,
    state: String,
    model: Option<String>,
    product: Option<String>,
    transport_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdbProbeResult {
    adb_path: Option<String>,
    adb_version: Option<String>,
    devices: Vec<DeviceInfo>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UiBounds {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    raw: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UiNode {
    id: String,
    index: Option<u32>,
    class_name: Option<String>,
    package: Option<String>,
    text: Option<String>,
    resource_id: Option<String>,
    content_desc: Option<String>,
    bounds: Option<UiBounds>,
    clickable: bool,
    enabled: bool,
    focusable: bool,
    focused: bool,
    scrollable: bool,
    selected: bool,
    visible_to_user: bool,
    children: Vec<UiNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiSnapshot {
    serial: String,
    root: Option<UiNode>,
    node_count: usize,
    xml_size: usize,
    screenshot_data_url: Option<String>,
    error: Option<String>,
    warning: Option<String>,
}

fn add_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_file() && !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

fn locate_adb() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    let adb_name = if cfg!(windows) { "adb.exe" } else { "adb" };

    for variable in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(sdk_root) = env::var(variable) {
            add_candidate(
                &mut candidates,
                PathBuf::from(sdk_root)
                    .join("platform-tools")
                    .join(adb_name),
            );
        }
    }

    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        add_candidate(
            &mut candidates,
            local_app_data
                .join("Android")
                .join("Sdk")
                .join("platform-tools")
                .join(adb_name),
        );

        // winget installs portable Platform-Tools under a versioned package folder.
        let winget_packages = local_app_data
            .join("Microsoft")
            .join("WinGet")
            .join("Packages");
        if let Ok(entries) = fs::read_dir(winget_packages) {
            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                if file_name.starts_with("Google.PlatformTools_") {
                    add_candidate(
                        &mut candidates,
                        entry.path().join("platform-tools").join(adb_name),
                    );
                }
            }
        }
    }

    if let Ok(user_profile) = env::var("USERPROFILE") {
        add_candidate(
            &mut candidates,
            PathBuf::from(user_profile)
                .join("AppData")
                .join("Local")
                .join("Android")
                .join("Sdk")
                .join("platform-tools")
                .join(adb_name),
        );
    }

    if let Ok(output) = Command::new(if cfg!(windows) { "where.exe" } else { "which" })
        .arg(adb_name)
        .output()
    {
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
            {
                add_candidate(&mut candidates, PathBuf::from(path));
            }
        }
    }

    candidates.into_iter().next()
}

fn run_adb(adb_path: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new(adb_path)
        .args(args)
        .output()
        .map_err(|error| format!("无法启动 adb：{error}"))
}

fn run_adb_for_device(adb_path: &Path, serial: &str, args: &[&str]) -> Result<Output, String> {
    Command::new(adb_path)
        .arg("-s")
        .arg(serial)
        .args(args)
        .output()
        .map_err(|error| format!("无法启动 adb：{error}"))
}

fn command_error(prefix: &str, output: &Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}：{detail}")
    }
}

fn attribute_value(event: &BytesStart<'_>, key: &str) -> Option<String> {
    event
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.as_ref() == key)
        .and_then(|attribute| {
            attribute
                .normalized_value(XmlVersion::Implicit1_0)
                .ok()
                .map(|value| value.into_owned())
        })
        .filter(|value| !value.is_empty())
}

fn attribute_bool(event: &BytesStart<'_>, key: &str, default: bool) -> bool {
    match attribute_value(event, key).as_deref() {
        Some("true") | Some("1") => true,
        Some("false") | Some("0") => false,
        _ => default,
    }
}

fn parse_bounds(raw: &str) -> Option<UiBounds> {
    let coordinates = raw
        .split(|character| matches!(character, '[' | ']' | ','))
        .filter_map(|part| part.trim().parse::<i32>().ok())
        .collect::<Vec<_>>();

    if coordinates.len() != 4 {
        return None;
    }

    Some(UiBounds {
        left: coordinates[0],
        top: coordinates[1],
        right: coordinates[2],
        bottom: coordinates[3],
        raw: raw.to_string(),
    })
}

fn ui_node_from_event(event: &BytesStart<'_>) -> UiNode {
    let bounds = attribute_value(event, "bounds").and_then(|value| parse_bounds(&value));

    UiNode {
        id: String::new(),
        index: attribute_value(event, "index").and_then(|value| value.parse::<u32>().ok()),
        class_name: attribute_value(event, "class"),
        package: attribute_value(event, "package"),
        text: attribute_value(event, "text"),
        resource_id: attribute_value(event, "resource-id"),
        content_desc: attribute_value(event, "content-desc"),
        bounds,
        clickable: attribute_bool(event, "clickable", false),
        enabled: attribute_bool(event, "enabled", true),
        focusable: attribute_bool(event, "focusable", false),
        focused: attribute_bool(event, "focused", false),
        scrollable: attribute_bool(event, "scrollable", false),
        selected: attribute_bool(event, "selected", false),
        visible_to_user: attribute_bool(event, "visible-to-user", true),
        children: Vec::new(),
    }
}

fn attach_ui_node(
    node: UiNode,
    stack: &mut Vec<UiNode>,
    root: &mut Option<UiNode>,
) -> Result<(), String> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(node);
    } else if root.is_none() {
        *root = Some(node);
    } else {
        return Err("UI hierarchy 包含多个根节点。".to_string());
    }

    Ok(())
}

fn assign_node_ids(node: &mut UiNode, id: String) {
    node.id = id.clone();
    for (child_index, child) in node.children.iter_mut().enumerate() {
        assign_node_ids(child, format!("{id}/{child_index}"));
    }
}

fn count_ui_nodes(node: &UiNode) -> usize {
    1 + node.children.iter().map(count_ui_nodes).sum::<usize>()
}

fn parse_ui_hierarchy(xml: &str) -> Result<UiNode, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut stack = Vec::new();
    let mut root = None;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) if event.name().as_ref() == "node" => {
                stack.push(ui_node_from_event(&event));
            }
            Ok(Event::Empty(event)) if event.name().as_ref() == "node" => {
                attach_ui_node(ui_node_from_event(&event), &mut stack, &mut root)?;
            }
            Ok(Event::End(event)) if event.name().as_ref() == "node" => {
                let node = stack
                    .pop()
                    .ok_or_else(|| "UI hierarchy 的节点闭合顺序无效。".to_string())?;
                attach_ui_node(node, &mut stack, &mut root)?;
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(format!("无法解析 UI hierarchy XML：{error}"));
            }
            _ => {}
        }
        buffer.clear();
    }

    if !stack.is_empty() {
        return Err("UI hierarchy XML 不完整。".to_string());
    }

    let mut root = root.ok_or_else(|| "UI hierarchy 中没有找到 node 节点。".to_string())?;
    assign_node_ids(&mut root, "0".to_string());
    Ok(root)
}

fn error_snapshot(serial: &str, error: String) -> UiSnapshot {
    UiSnapshot {
        serial: serial.to_string(),
        root: None,
        node_count: 0,
        xml_size: 0,
        screenshot_data_url: None,
        error: Some(error),
        warning: None,
    }
}

fn parse_device_line(line: &str) -> Option<DeviceInfo> {
    let mut fields = line.split_whitespace();
    let serial = fields.next()?;
    let state = fields.next()?;

    if serial == "List" || serial == "*" || state == "of" {
        return None;
    }

    let mut model = None;
    let mut product = None;
    let mut transport_id = None;

    for field in fields {
        if let Some((key, value)) = field.split_once(':') {
            match key {
                "model" => model = Some(value.replace('_', " ")),
                "product" => product = Some(value.to_string()),
                "transport_id" => transport_id = Some(value.to_string()),
                _ => {}
            }
        }
    }

    Some(DeviceInfo {
        serial: serial.to_string(),
        state: state.to_string(),
        model,
        product,
        transport_id,
    })
}

#[tauri::command]
fn probe_adb() -> AdbProbeResult {
    let Some(adb_path) = locate_adb() else {
        return AdbProbeResult {
            adb_path: None,
            adb_version: None,
            devices: Vec::new(),
            error: Some("未找到 adb。请安装 Android SDK Platform-Tools 后重试。".to_string()),
        };
    };

    let adb_path_string = adb_path.to_string_lossy().to_string();
    let adb_version = run_adb(&adb_path, &["version"]).ok().and_then(|output| {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .find(|line| line.contains("Android Debug Bridge version"))
            .map(str::trim)
            .map(ToOwned::to_owned)
    });

    let devices_output = match run_adb(&adb_path, &["devices", "-l"]) {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return AdbProbeResult {
                adb_path: Some(adb_path_string),
                adb_version,
                devices: Vec::new(),
                error: Some(if detail.is_empty() {
                    "adb 无法读取设备列表。".to_string()
                } else {
                    format!("adb 无法读取设备列表：{detail}")
                }),
            };
        }
        Err(error) => {
            return AdbProbeResult {
                adb_path: Some(adb_path_string),
                adb_version,
                devices: Vec::new(),
                error: Some(error),
            };
        }
    };

    let devices = String::from_utf8_lossy(&devices_output.stdout)
        .lines()
        .filter_map(parse_device_line)
        .collect();

    AdbProbeResult {
        adb_path: Some(adb_path_string),
        adb_version,
        devices,
        error: None,
    }
}

#[tauri::command]
fn inspect_device(serial: &str) -> UiSnapshot {
    let Some(adb_path) = locate_adb() else {
        return error_snapshot(
            serial,
            "未找到 adb。请安装 Android SDK Platform-Tools 后重试。".to_string(),
        );
    };

    let dump_output = match run_adb_for_device(
        &adb_path,
        serial,
        &[
            "shell",
            "uiautomator",
            "dump",
            "--compressed",
            "/sdcard/window_dump.xml",
        ],
    ) {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return error_snapshot(serial, command_error("无法导出 UI hierarchy", &output));
        }
        Err(error) => return error_snapshot(serial, error),
    };

    let xml_output = match run_adb_for_device(
        &adb_path,
        serial,
        &["exec-out", "cat", "/sdcard/window_dump.xml"],
    ) {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return error_snapshot(serial, command_error("无法读取 UI hierarchy XML", &output));
        }
        Err(error) => return error_snapshot(serial, error),
    };

    let xml_size = xml_output.stdout.len();
    let xml = String::from_utf8_lossy(&xml_output.stdout).to_string();
    let root = match parse_ui_hierarchy(&xml) {
        Ok(root) => root,
        Err(error) => return error_snapshot(serial, error),
    };
    let node_count = count_ui_nodes(&root);

    let (screenshot_data_url, warning) =
        match run_adb_for_device(&adb_path, serial, &["exec-out", "screencap", "-p"]) {
            Ok(output) if output.status.success() && !output.stdout.is_empty() => (
                Some(format!(
                    "data:image/png;base64,{}",
                    BASE64_STANDARD.encode(&output.stdout)
                )),
                None,
            ),
            Ok(output) => (
                None,
                Some(command_error("UI hierarchy 已读取，但截图失败", &output)),
            ),
            Err(error) => (
                None,
                Some(format!("UI hierarchy 已读取，但截图失败：{error}")),
            ),
        };

    let _ = dump_output;
    UiSnapshot {
        serial: serial.to_string(),
        root: Some(root),
        node_count,
        xml_size,
        screenshot_data_url,
        error: None,
        warning,
    }
}

#[cfg(test)]
mod tests {
    use super::{count_ui_nodes, parse_device_line, parse_ui_hierarchy};

    #[test]
    fn parses_extended_adb_device_line() {
        let device =
            parse_device_line("R58M123ABC device product:panther model:Pixel_8_Pro transport_id:3")
                .expect("a device line should be parsed");

        assert_eq!(device.serial, "R58M123ABC");
        assert_eq!(device.state, "device");
        assert_eq!(device.model.as_deref(), Some("Pixel 8 Pro"));
        assert_eq!(device.product.as_deref(), Some("panther"));
        assert_eq!(device.transport_id.as_deref(), Some("3"));
    }

    #[test]
    fn ignores_adb_table_header() {
        assert!(parse_device_line("List of devices attached").is_none());
        assert!(parse_device_line("").is_none());
    }

    #[test]
    fn parses_uiautomator_tree_and_assigns_paths() {
        let xml = r#"
            <?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
            <hierarchy rotation="0">
              <node index="0" text="" resource-id="" class="android.widget.FrameLayout"
                    package="com.example" content-desc="" clickable="false" enabled="true"
                    focusable="false" focused="false" scrollable="false" selected="false"
                    visible-to-user="true" bounds="[0,0][1080,2400]">
                <node index="0" text="确定 &amp; 继续" resource-id="com.example:id/confirm"
                      class="android.widget.Button" package="com.example" content-desc="确认"
                      clickable="true" enabled="true" focusable="true" focused="false"
                      scrollable="false" selected="false" visible-to-user="true"
                      bounds="[820,2100][1040,2240]" />
              </node>
            </hierarchy>
        "#;

        let root = parse_ui_hierarchy(xml).expect("valid hierarchy should parse");
        assert_eq!(root.id, "0");
        assert_eq!(root.children[0].id, "0/0");
        assert_eq!(root.children[0].text.as_deref(), Some("确定 & 继续"));
        assert_eq!(
            root.children[0].resource_id.as_deref(),
            Some("com.example:id/confirm")
        );
        assert_eq!(
            root.children[0].bounds.as_ref().map(|bounds| bounds.left),
            Some(820)
        );
        assert!(root.children[0].clickable);
        assert_eq!(count_ui_nodes(&root), 2);
    }

    #[test]
    fn rejects_hierarchy_without_nodes() {
        let result = parse_ui_hierarchy("<hierarchy rotation=\"0\" />");
        assert!(result.is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![probe_adb, inspect_device])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
