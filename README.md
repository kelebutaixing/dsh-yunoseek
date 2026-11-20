# dsh-yunoseek · 千石由乃主题包

一个 DSH 插件：由乃主题 + 消息头像 + Live2D 桌宠 + 日语语音朗读 + `yuno` Agent 预设。

## 安装

### 方式一：直接下安装包（推荐）

到 [Releases](../../releases) 下载最新的 `dsh-yunoseek-v*.zip`（约 367 MB，桌宠模型和语音权重都在里面），解压到任意位置，然后：

```powershell
dsh plugin --profile <你的 profile> add link:<解压出来的目录>
```

### 方式二：从源码装

仓库里只有代码，`models/`、`assets/`、`refs/` 三块没有（单文件超过 GitHub 100 MB 限制），要从上面的 Release 包里拷进来。

```powershell
git clone https://github.com/kelebutaixing/dsh-yunoseek.git
cd dsh-yunoseek
# 把 Release 包里的 models/ assets/ refs/ 三个目录拷到这个目录下
dsh plugin --profile <你的 profile> add link:<这个目录的绝对路径>
```

装完**重启 DSH**。

---

## yuno Agent 预设

新建会话时在预设里选 `yuno`，整个会话就用千石由乃的语气说话。

- **工具集和标准模式完全一样**，只是换人设，能力不打折
- 说话短、平、慢，先给结论再补一两句；被夸会含糊过去，被拜托先嫌一句"麻烦"然后照样做完
- 聊到音源、器材、编曲这类她在意的东西，会开始一个人讲下去，讲到一半自我修正
- 聊天时会在末尾留一行日语稿 `〔ゆの：…〕`，语音插件念的就是这一行；不需要语音时可以不理它

## 桌宠

Live2D 桌宠常驻在窗口里，不挡操作。

- **4 套衣服**：校服 / 便服 / 演出服 / 虚拟主播，设置里随时换
- 表情、口型（说话时嘴会动）、点击反应、待机动作
- **视线跟随**：鼠标移出 DSH 窗口也照样看着它（靠 koffi 读全局光标，`pnpm install` 会自动装）
- 大小、透明度、显示位置、是否跟随、是否待机动作，都能单独调；不想看就关掉

## 语音

把回复里的日语稿用 GPT-SoVITS 念出来，中文正文不念。

- 按句切分、按句排队播，长回复不会卡住半天才出声
- 8 段参考音频按语气分类（日常 / 提问 / 建议 / 思考），合成时自动挑合适的那段
- 音色、一次最多念多少字、是否自动朗读，都在「设置 → 语音」里

引擎本体（GPT-SoVITS）需要自己装一份，装好在设置里填引擎目录即可；**权重和参考音频包里已经带了**，路径不用改。没装引擎就是安静地不出声，不影响其它功能。

---

## 素材来源

- **Live2D 桌宠模型**：bilibili [@自然常数2718](https://space.bilibili.com/412160077)
- **语音模型（GPT-SoVITS 权重）**：bilibili [@毛绒十面体](https://space.bilibili.com/541528)