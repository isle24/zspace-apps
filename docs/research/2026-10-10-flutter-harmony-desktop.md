# Flutter 与鸿蒙评估：后续原生手机范围

用户曾允许全端Flutter评估；最新决定是 PC 用 Tauri，当前手机只做 H5。本文保留后续原生 iOS/Android/HarmonyOS 的调研，不作为当前 PC 实现方案。

Flutter官方支持平台：[平台列表](https://docs.flutter.dev/reference/supported-platforms)。原生鸿蒙依赖 CPF-Flutter 维护适配版，HAP与AndroidAPK分别构建与验收。

已只读验证 refs：3.35.8-ohos-1.0.4 对应 8320f6ded3f0bdc5409545e26dcd2596bf054203；3.41.10-ohos-1.0.1 对应 adaf911c35c9136a7d18fc424d714c9ec7724e60。维护入口：[CPF-Flutter](https://atomgit.com/CPF-Flutter/flutter_flutter)。版本引用存在不等于必需插件已全部验收。

后续必须逐项验证凭据、文件流、视频、音频、AVSession和后台任务。鸿蒙手机文件目录选择与NAS目录选择是不同能力；大文件不能默认整体载入内存。[文件选择维护说明](https://gitcode.com/CPF-Flutter/flutter_packages/blob/br_file_selector-v1.1.0_ohos/packages/file_selector/file_selector_ohos/README.md)、[音频维护说明](https://gitcode.com/CPF-Flutter/fluttertpc_just_audio/blob/br_v0.10.5_ohos/README.OpenHarmony_CN.md)。

Flutter原生Mac/iOS需完整Xcode，原生插件按版本使用Pods/SwiftPM；但这不要求当前Tauri PC迁移到Flutter。GitHub与所有原生手机构建均后置。
