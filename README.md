# 千石由乃整合包 · yuno ai

一个 DSH 插件，装一次把千石由乃（夢限大みゅーたいぷ 的 DJ & Manipulator）这一整套界面、桌宠和语音全上。

## 里面有什么

| 部件 | 功能 |
|---|---|
| 主题 | 粉紫黑配色、霓虹氛围层、调音台、直播 overlay、侧栏品牌名 |
| 头像 | 每条助手消息左边一个圆形头像（朗读时光圈会亮） |
| 桌宠 | Live2D 桌宠，4 套衣服、表情、口型、点击反应、视线跟随 |
| 语音 | 把回复里的 `〔ゆの：…〕` 用 GPT-SoVITS 念出来（日语） |
| 预设 | Agent 预设「yuno」：工具集与标准模式一致，只换人设 |

桌宠的 Live2D 模型（4 套，约 63 MB）、语音权重（约 300 MB）和 8 段参考音频都已经在包里。

## 装

### 方式一：直接下安装包（推荐）

到 [Releases](../../releases) 下载最新的 `dsh-yuno-ai-v*.zip`（约 367 MB，**模型、Live2D 和参考音频都在里面**），解压到任意位置，然后：

```powershell
dsh plugin --profile <你的 profile> add link:<解压出来的目录>
```

### 方式二：从源码装

仓库里只有代码，`models/`、`assets/`、`refs/` 三块被排除在外（单文件超过 GitHub 100 MB 限制）。所以：

```powershell
git clone <仓库地址> dsh-yuno-ai
cd dsh-yuno-ai
```

再从上面那个 Release 包里把 `models/`、`assets/`、`refs/` 三个目录拷进来，最后：

```powershell
dsh plugin --profile <你的 profile> add link:<这个目录>
```

也可以手动在 profile 的 `package.json` 里加：

```json
{
  "dependencies": { "dsh-yuno-ai": "link:<路径>" },
  "dsh": { "profile": { "bundles": ["...", "dsh-yuno-ai"] } }
}
```

装完重启 DSH。装上之后：

- 界面换成品红配色，侧栏品牌名变成「千问豆乃包」
- 助手回复左边出现圆形头像
- 右下角出现桌宠（设置 → 桌宠 里调大小、透明度、换衣服、关掉）
- 设置里多「语音」「桌宠」两个分区
- 新建会话时预设里多一个 `yuno`

## 语音

包里带的是「嗓子」（模型权重 + 参考音频），不带「肺」（GPT-SoVITS 引擎本体）。

1. 准备一份 GPT-SoVITS v5，目录里要有 `GPT_SoVITS/` 和 `runtime/python.exe`
2. 设置 → 语音 → **引擎目录**，填上一步那个目录（python 留空会自动用 `<引擎目录>\runtime\python.exe`）
3. 权重路径不用改，默认指向包里的模型
4. 点「试听」。第一次会拉起引擎，加载 15~45 秒（占用显存约 2.6 GB），之后每次合成都很快
5. 想开机就热着，把「自动拉起引擎」打开

没配引擎时语音静默不出声，不报错，也不影响其它功能。日志在 `~/.dsh/yuno-tts/engine.log`。

## 桌宠

- 4 套衣服（校服 / 便服 / 演出服 / 虚拟主播服），设置里切
- 视线跟随靠 `koffi` 读 Win32 全局光标（放在 optionalDependencies，pnpm 默认会装）。少了它，鼠标移出窗口后视线就不跟了
- 位置、大小、透明度、点击反应、口型、待机动作都能单独调

## 自检

DSH 跑着的时候打开：

```
http://127.0.0.1:<DSH 端口>/yuno-kit
```

返回一段 JSON：桌宠模型在不在、语音权重在不在、引擎配没配好、python 找不找得到。

## 卸

```powershell
dsh plugin --profile <profile> remove dsh-yuno-ai
```

再把 profile 的 `bundles` 里那行删掉，重启。

## 目录

```
index.js          宿主侧：/yuno-pet、/yuno-tts、/yuno-kit 三条路由
host/             宿主侧实现（桌宠发模型、语音管引擎进程）
client.js         浏览器侧入口（构建产物，别手改）
cordis.patch.yml  挂载声明：本体 + 「yuno」预设
assets/yuno/      桌宠 Live2D 模型（4 套）
models/           语音模型权重
refs/             8 段参考音频
server/           引擎脚本与 prompt 文本表
scripts/          开机预热引擎的启动器
src/              构建与测试脚本，普通使用不需要
```

## 开发

```powershell
node src/build.mjs           # 重新合成 client.js（改完 src/parts 里的任一份之后跑）
node src/make-patch.mjs      # 重新生成 cordis.patch.yml
node src/test-host.mjs       # 宿主侧：三条路由、模型扫描、自检返回
node src/test-client-node.mjs # 浏览器侧：模块注册、inject 并集、槽位挂载、幂等
```

`src/build.mjs` 会优先读 `src/parts/` 里那四份 client bundle 备份（主题 / 头像 / 桌宠 / 语音），
把它们各自的 `factory` 体剥出来合成一个入口。入口的模块 id 必须等于包名，改了包名要同步改 `PACKAGE_ID`。

## 已知限制

- 体积约 380 MB，大头是语音权重
- 主题跟随 DSH 的明暗模式。她本来的样子是深色（深紫 × 品红），切到浅色会变成粉紫
- 语音只念日语稿（`〔ゆの：…〕` 那一行），不念中文正文
- 长句会拖音（模型本身的毛病），前端按句切分，一般听不出来