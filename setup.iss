#define MyAppName "续声"
#define MyAppVersion "0.3.1"
#define MyAppPublisher "续声"
#define MyAppExeName "续声.exe"
#ifndef MyAppAsarSource
#define MyAppAsarSource "resources\app.asar"
#endif

[Setup]
AppId={{D764D0BC-CF29-4EBD-B669-C53060B4FA93}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=.
OutputBaseFilename=续声_安装包_v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
SetupIconFile=app.ico
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\续声.exe
PrivilegesRequired=admin

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标:"

[Files]
; 主程序
Source: "续声.exe"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
; Electron 运行时 DLL
Source: "d3dcompiler_47.dll"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "ffmpeg.dll"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "libEGL.dll"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "libGLESv2.dll"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "vk_swiftshader.dll"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "vulkan-1.dll"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
; 数据文件
Source: "icudtl.dat"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
; 快照文件
Source: "snapshot_blob.bin"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "v8_context_snapshot.bin"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
; 资源包
Source: "chrome_100_percent.pak"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "chrome_200_percent.pak"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "resources.pak"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
; Vulkan 配置
Source: "vk_swiftshader_icd.json"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
; 语言包：仅保留中文与英文回退，避免把全部 Chromium locale 打进安装包
Source: "locales\zh-CN.pak"; DestDir: "{app}\locales"; Flags: ignoreversion uninsremovereadonly
Source: "locales\en-US.pak"; DestDir: "{app}\locales"; Flags: ignoreversion uninsremovereadonly
; ASAR 应用包
Source: "{#MyAppAsarSource}"; DestDir: "{app}\resources"; DestName: "app.asar"; Flags: ignoreversion uninsremovereadonly
; 许可证和说明
Source: "LICENSE.electron.txt"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "LICENSES.chromium.html"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly
Source: "使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion uninsremovereadonly

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 续声"; Flags: nowait postinstall skipifsilent
