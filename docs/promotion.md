# PoseRelay 试玩与双语介绍

让小克在观众能亲手打开的播放器里完成演示。先用静音待机、单侧受击和三姿态完成手机与桌面的首次打开测试，再录中英两版。试玩页与录制共用角色包和播放器。

## 首轮验收

- 从正面进入，画面加载后几秒内能看见刘海、呼吸或眨眼。自动待机支持低、中、高呼吸，说话时眨眼节奏放缓。
- 点击任何姿态中可见的胸部区域，只有对应一侧受击，轻、中、重按不同概率触发。说明旁提供键盘可用的左右按钮。
- 试听台词有口型，停止后闭口。转场期间静音，到位后继续待机，也能继续说话。
- 录制可以导入三条本地 WAV，按正面、右看和回正顺序复播。桌面支持录制时下载含配音的画面文件。
- 英文 README 首屏直接播放现成的静音转场预览。宣传片结尾指向网页试玩和 GitHub 仓库。

## 同一组镜头，两种语言

把三段台词分别录成 WAV。每段留出一点自然停顿。转场由播放器插入静音，台词长度由配音决定。

| 镜头 | 中文配音 | English voice-over |
| --- | --- | --- |
| 正面，开头先留约两秒让观众看见待机 | 你好，我是小克。你看，我不用说话也会眨眼、呼吸。现在我换个姿势，等我转过去，我们再接着聊。 | Hi, I'm Claude. Even when I'm quiet, I can blink and breathe. Watch me turn, and I'll pick up right where I left off. |
| 右看，接上上一句 | 我到这边了。刚才转身用的是提前准备好的短片。在这个姿势里，我又能跟着配音开口，也可以靠实时图层做待机和动作。 | Here I am. That turn was a clip prepared in advance. In this pose, my mouth follows the voice track again, and the layers still let me idle and react. |
| 回正，压流程图与 GitHub 地址 | 这就是 PoseRelay。首版可以用准备好的素材，在本地检查、看片和打包。你可以打开试玩页，点一下试试。如果你也有个角色想试，GitHub 上有代码和样例。 | That's PoseRelay. The first release lets you validate, review, and package prepared assets locally. Open the demo and give it a try. If you have a character of your own, the code and examples are on GitHub. |

B 站用中文声音与中文字幕，YouTube 用英文声音与英文字幕。画面按同一套镜头顺序剪辑。正式成片用同一档待机和录制设置，保留转场前后的原速画面。

用自己的语音服务时，在同页按钮点击后调用 `window.canteen.sayAudio(blob)`，传入音频 Blob 或 ArrayBuffer。口型直接由该音频驱动，已有试音和本地录制也沿用同一口型逻辑。

首次试单可以约定一套已有角色素材、一个姿态、一个动作和输出格式，先交付一个可以播放的样例。记录来自公开链接的询价，以及愿意提供素材试做的人数。
