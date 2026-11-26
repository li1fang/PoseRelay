# PoseRelay 发布说明 · Release notes

## v0.1.1

小克打开即进入正面自动待机。呼吸在三档间过渡，待机和说话使用不同的眨眼节奏，点击胸部或按对应的左右按钮即可触发单侧受击。中英文试玩页带有一条内置试听音频，也可用三段本地 WAV 排演与录制。

Claude starts in an animated idle pose with automatic breathing and speech-aware blinking. Click either side of the chest or use the corresponding button to try a one-sided impact. The bilingual demo includes a test line and can rehearse or record a three-pose sequence with local WAV files.

## v0.1.0

## 简体中文

首个公开版本包含一个带实时口型的三姿态播放器、角色库和本地打包工具。小克的六条转场在浏览器逐条实播，切换期间保持静音，到位后可以继续说话。角色库的 21 个固定画面逐一检查了口型与清单声明的交互能力。

使用准备好的角色定帧、图层、转场短片和语音，可以完成本地校验、人工质检和重新打包。API 评审可导入外部结论，使用相同的评审记录。发布包在干净目录通过零 API 人工路径复跑。

开始使用见 [中文版 README](README.md)，素材来源见 [样例资产](ASSETS.md)，许可见 [MIT](LICENSE)。

## English

The first public release includes a three-pose player with real-time lip sync, a portrait gallery, and a local packaging tool. All six Claude transitions were replayed in a browser, with silence during transitions and speech available again on arrival. All 21 gallery views were checked for lip sync and the interactions declared in the manifest.

Use prepared pose images, layers, transition clips, and audio to validate, review, and rebuild a character bundle. External API decisions can be recorded in the same review format. The release was tested from a clean directory through the manual review and packaging path with zero API calls.

Start with the [English README](README.en.md). See the [asset inventory notes](ASSETS.md) and the [MIT license](LICENSE) for sources and terms.
