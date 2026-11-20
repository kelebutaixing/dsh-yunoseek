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

## 装好之后

- 界面换成品红配色，侧栏品牌名变成「千问豆乃包」
- 设置里多「语音」「桌宠」两个分区
- 新建会话时预设里有 `yuno`

语音要出声，还需要自己装一份 GPT-SoVITS，然后在「设置 → 语音」里把引擎目录填上（权重和参考音频包里已经有了）。没配就是不出声，不影响其它功能。