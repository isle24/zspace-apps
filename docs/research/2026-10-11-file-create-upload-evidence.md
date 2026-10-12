# 官方新目录与上传协议证据

2026-10-11，只读取当前 NAS 无需认证的前端静态资源；未上传文件、新建 NAS 目录或改变任何服务、索引、历史和既有资料。

## 已确认的新目录调用

主资源 [index.f6361495.js](http://192.168.3.56:5055/home/static/js/index.f6361495.js) SHA-256 为 `61003b9452b584b5a30e0dd30631398a9650ea711d9a1d47669d8a8a4a81aff0`。公开包装模块5219定义普通 POST `/v2/file/newdir`；远程包装使用另外的 `/zconn/http/5055/{nasid}/v2/file/newdir`。

文件界面 [73512.5a29862a.js](http://192.168.3.56:5055/home/static/js/async/73512.5a29862a.js) SHA-256 为 `4de8ce459941a02af90590e76685b874ad36281bf8fc8b9b5c07f89de1760599`。当前调用是 `{parent:currentPath,name:输入名称,rename:+!!t}`。parent来自已打开的真实目录，不能由显示标题猜测。新客户端的保留资料策略不应提供覆盖既有内容的选项。

官方包装不能仅以业务 `success` 判断新建成功：当 `abs(floor(response.ts/1000)-response.data.modify_time)>2` 时，将结果改为失败并使用 `N001322` 表达同名冲突。这说明响应外层时间与实际目录修改时间具有具体判定意义；现有只返回data的通用读取包装不能未经适配直接宣布目录新建完成。真实创建、碰撞行为与返回身份仍需正常会话下在全新测试目录验收。

## 已确认的上传入口，尚非完整协议

同一模块5219的 `upload` 包装使用 POST `/v2/file/upload?remote_port=8050`，原始字节 Content-Type `application/octet-stream`、调用者提供的headers、进度回调和取消对象；另有 GET `/v2/file/tmpinfo` 及 POST `/v2/file/upload/whyfail`。

文件界面的网页上传入口只发出 `file-upload` 事件，内容 `{app:"file",basePath:currentPath,mode:"file"|"folder"}`；原生官方客户端另用IPC启动任务。以上入口本身不足以确定上传数据头和冲突处理，不能只凭它编写假定multipart或覆盖参数的实现。以下继续采集桌面的公开上传器。

该上传入口与 `/themeapp/property/image/upload` 不同；后者是主题属性图片，不应用于一般NAS文件。此次没有添加上传接口、native权限或实际写请求。

## 公开桌面上传器的分块协议

官方桌面路由引用 [85365.1b18201a.js](http://192.168.3.56:5055/home/static/js/async/85365.1b18201a.js)，432,396字节，SHA-256 `188505612445ce8cb154e5a1815241558b0e32006cd699813b20e7c8d2695493`。这里只阅读静态源码，没有执行该上传器。

`getParams` 产生HTTP数据头：app、URI编码的真实目标path、完整size、uuid、seek、crtime、modify_time、rename，以及私有token、plat、nasid、version、device_id、device、remote-port=8050、request-purpose=4；按平台另加device-type。普通文件app来自文件入口。可选图片信息不属于最低文件上传契约。UUID由lastModified、size和targetPath构造；seek等于已确认的finishedSize。

网页上传方法添加split=1，再把File.slice(finishedSize,end)作为原始字节发送。一般远程形态每块2MiB；本地形态使用配置或默认100MiB，且在5055网页来源下可能改用8050端口。用户的新客户端目标为官方5055，因此任何8050直接连接都需另外证据，不扩大当前端口范围。只有上一块返回业务成功，才推进finishedSize和下一块。最后一块可带fileHash和fileHashCheckOption；源码支持complete与采样simple MD5，两者不可互称完整校验。

暂停恢复查询GET `/v2/file/tmpinfo` 的path/uuid并读取data.size；原生源文件丢失、权限/空间不足、取消和冲突另有状态。新客户端不应照搬官方日志中的路径、错误正文或持久化任务中的敏感字段。窗口关闭不是取消上传；用户退出或显式取消需终止当前会话传输，不清理NAS上的未完成资料。

当前同名提示的“保留两份”按钮调用renameAction(1)，随后rename=1发送服务端；“跳过”为action2，在线请求实际改为rename=0，客户端直接结束而不续传。默认rename0冲突返回N001301后等待处理。以上是当前公开UI与请求的关联证据，仍需在全新自建测试目录比较既有标记文件、实际返回路径和完整哈希，才可验收资料保护及分块/空文件行为。不能凭参数名称推断服务器绝不覆盖。

后续实现可以先支持仅用户选择的新目录和单文件，不提供覆盖/递归删除/自动恢复旧任务。使用成熟系统文件选择、reqwest和有界块读取，核对实际源身份、会话、累计确认和最终完整性。真实NAS写入验收应继续遵守限定新目录，保留所有测试资料。

## 算法与名称校验补充采集

2026-10-11再次读取匿名公开桌面依赖。资源 [74789.8ad0d671.js](http://192.168.3.56:5055/home/static/js/async/74789.8ad0d671.js) SHA-256 `b2d4d0f54327dfc0ffffe48ced87cacb122676063beec20e8d581d530c5eb4ec`，模块93810明确实现SHA-1。上传器tQ使用该模块，UUID输入为JavaScript的 `(file.lastModified + file.size) + targetPath`，即先作数值加法，再连接真实目标路径；不是直接拼接三个字符串。其源文件快速指纹先更新完整size的十进制字符串：空文件不读字节；size<=2048读取整个文件一次；更大文件才读取首尾各1024字节。不能对小文件重复追加重叠的首尾内容。

首页实际引用的公共资源 [34693.faa26133.js](http://192.168.3.56:5055/home/static/js/34693.faa26133.js)，5,714,735字节，SHA-256 `7bd751625d438512e8cbebbf88b0339c553eb6be01ceaf4c4997afc2b302e28b`，模块88495明确实现MD5。上传器V使用该模块作为fileHash：complete分支遍历全文件；simple分支可能采样。完整MD5用于当前NAS文件完整性协议，不作为密码存储或安全签名算法。不能将SHA-1任务标识、源文件快速指纹、采样MD5和完整MD5互称。

公开文件帮助模块71617的qR仅判断去掉空白后是否为空，不能把它当成完整的路径/名称安全校验。新客户端另约束单组件名称、控制字符、Unicode有效性和UTF-8长度，并验证实际父目录、返回路径及读回身份。没有执行公开脚本、上传数据或创建真实NAS目录。

已查阅 [noble-hashes 2.4.0官方发行](https://github.com/paulmillr/noble-hashes/releases/tag/2.4.0)及[官方说明](https://github.com/paulmillr/noble-hashes/blob/main/README.md)：legacy.js提供增量MD5和SHA-1。后续文件协议兼容采用固定版本库，不自行抄写散列实现；完整SHA-256另用于本地内容校验，不把MD5/SHA-1当认证或安全签名。
