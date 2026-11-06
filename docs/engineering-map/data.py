"""Public, static engineering inventory. No runtime discovery or product API calls."""
SYSTEMS = [
 ('A','H5与安卓原生壳','H5先行复用现有API；安卓壳接原生能力，旧Compose仅作历史参照。',['R03','R04','R05','R06','R07','R09','R14'],'H5先行 / 安卓平台目标','decisions.md',['A03','A06','A07','A09','A28','A30']),
 ('B','事件与回应账本','保存原事件、版本、回应、用户决定和不可混淆的事实。',['R02','R03','R04','R06','R07','R09'],'首轮','../server/README.md',['A01','A02','A08','A09','A17','A18']),
 ('C','身份设备与权限','区分用户、来源、设备和授权；实际写门核当前资格。',['R05','R07','R09','R13'],'首轮 / 日常','../server/README.md',['A13','A14','A20','A21','A29','A30']),
 ('D','通知与同步','持久提醒、最少披露和分层回执，不把推送当已读。',['R06','R07','R14','R15'],'首轮 / 日常','../android/README.md',['A04','A05','A07','A24','A25','A30']),
 ('E','精确交付与证据','原回应只到准确原目标；未知只查原事实，不重复执行。',['R05','R06','R07','R08','R09','R13'],'首轮','../server/README.md',['A03','A08','A09','A10','A12','A13','A14','A17','A29']),
 ('F','来源与可替换助理','程序、云端澪和更多助理接入同一公共事件体系。',['R02','R05','R06','R11','R13'],'首轮 / 扩展','../pi-host/README.md',['A03','A13','A17','A19','A20']),
 ('G','本地连接器与观察','主动出站、持久原包、Uniflo只读映射和安全背压。',['R02','R07','R08','R10','R13','R15'],'日常 / 扩展','../connectors/README.md',['A11','A15','A16','A25','A26','A27','A29']),
 ('H','工作方式与跟办','筛变化、何时打扰、怎样提问和跟踪，保留通用方案。',['R03','R04','R11','R12','R13'],'首轮薄配置 / 扩展','plugins.md',['A17','A18','A19','A23','A24']),
 ('I','扩展记忆与媒体','受控扩展、外部记忆、版本化卡片与媒体对象合同。',['R04','R11','R12','R13'],'扩展','plugins.md',['A14','A19','A20','A22','A23','A26','A30']),
 ('J','自托管与生命周期','长期运行、诊断、容量、备份恢复、构建及分发。',['R01','R07','R13','R14','R15'],'首轮 / 日常','architecture.md',['A09','A10','A20','A25','A26','A27','A30'])]
NODES=[]; APIS={}; EDGES=[]
for sid,title,purpose,req,scope,doc,acc in SYSTEMS:
 NODES.append(dict(id=sid,system=sid,level=1,title=title,purpose=purpose,expected=purpose,existing='查看本系统的功能与合同入口。源码存在不等于相应版本已发布或完整验收。',scope=scope,req=req,acceptance=acc,code=[],docs=[doc,'requirements.md','acceptance.md'],apis=[],gaps=[]))

def gap(kind,note,basis): return dict(kind=kind,note=note,basis=basis)
def node(id,parent,title,purpose,code=(),apis=(),gaps=(),expected=None,existing=None,docs=(),scope=None):
 root=next(n for n in NODES if n['id']==id[0])
 n=dict(id=id,system=id[0],parent=parent,level=2 if parent==id[0] else 3,title=title,purpose=purpose,expected=expected or purpose,existing=existing or '下列代码/合同是本地图核对的定位入口；适用候选、验证和发布结论只看实施路线。',scope=scope or root['scope'],req=list(root['req']),acceptance=list(root['acceptance']),code=list(code),docs=list(dict.fromkeys([*docs,*root['docs']])),apis=list(apis),gaps=list(gaps))
 NODES.append(n); return n

def api(id,method,path,title,inputs,outputs,boundary,code,receiver,callers,protocol='本项目 HTTP',kind='http',receipt=None):
 APIS[id]=dict(id=id,method=method,path=path,title=title,inputs=inputs,outputs=outputs,boundary=boundary,code=code,to=receiver,from_=callers,protocol=protocol,kind=kind,receipt=receipt or outputs)

def proposal(id,title,contract,to,callers,docs):
 APIS[id]=dict(id=id,method=None,path=None,title=title,inputs=contract,outputs='具体wire字段、方法和回执格式未由本图制定。',boundary='提案，不是可调用接口；不能用现有回应API替代。',code=docs,to=to,from_=callers,protocol='所需能力语义',kind='proposal',receipt='需在实际合同中定义原请求事实查询与相应层级回执。')

# A: H5 target, Android native boundary, and explicitly retained Compose references.
node('A.web','A','H5界面与API消费','先交可运行客户端，不重做Fastify/TypeScript/SQLite账本。',code=['../web/package.json'],docs=['tasks/web-001-event-client.md','requirements.md'],scope='H5首个有界切片')
node('A.web.client','A.web','现有API事件闭环','连接/身份、收件箱、详情/历史、回应及原ID未知恢复。',code=['../web/src/main.tsx','../web/src/client.ts','../web/src/api.ts','../web/src/ledger.ts'],apis=['events.list','events.get','events.history','response.post','response.get','read.put','disposition.post'],existing='Web合同入口是web-001，代码归属web/；下列源码仅作定位，不从框架/文件存在推出功能通过。库和壳细节由实际TASK落实，地图HTML不是产品UI；实现、自测与独审状态只见路线。',docs=['tasks/web-001-event-client.md'],gaps=[gap('evidence','Web按自身TASK、浏览器/真实API和准确候选分别核验；原Compose或本地图工具检查不迁签为Web通过。','decisions.md')],scope='H5首个有界切片')
node('A.native','A','安卓原生壳','复用H5界面/业务，通知/后台/锁屏/Keystore/生命周期仍需原生。',docs=['decisions.md','requirements.md'],scope='安卓平台目标 / 原生验证')
node('A.native.bridge','A.native','桥接与平台事实','最小能力、权限、安全存储和生命周期的真实原生接入。',apis=['shell.proposal'],existing='原Compose通知/安全存储可作历史合同参照，不代表新壳桥接实现。具体壳、依赖和协议由相应TASK落实，本图不冻结。',docs=['decisions.md'],gaps=[gap('contract','H5与原生通知/生命周期/Keystore之间的能力、权限、持久化与回执边界须在壳TASK定义；本图不编桥接方法或HTTP路径。','decisions.md'),gap('evidence','网页前台/浏览器存储不替代Android后台/锁屏、安全存储或WebView性能证据；H5不自动解决缓存性能。','requirements.md#8-非功能约束与待量化项')],scope='安卓平台目标 / 原生验证')
proposal('shell.proposal','H5 ↔ 安卓原生能力桥接','复用界面/业务；原生通知、后台/锁屏、系统权限、Keystore与生命周期另落实最小能力/回执边界','A.native.bridge',['A.web.client'],'decisions.md')
node('A.inbox','A','收件箱与详情','当前内容、历史、阅读与用户决定分开呈现。',['../android/app/src/main/java/dev/notifier/app/MainActivity.kt'])
node('A.inbox.read','A.inbox','当前内容与回执','离线内容标观察时间；旧回执不提升当前版本。',['../android/app/src/main/java/dev/notifier/app/Ledger.kt'],['events.list','events.get','events.history','response.get','read.put','disposition.post'])
node('A.respond','A','回应与未知对账','先持久原ID/正文，再提交；丢ACK查原回应。',['../android/app/src/main/java/dev/notifier/app/Ledger.kt'])
node('A.respond.contract','A.respond','稳定回应意图','离线草稿不是服务端保存，恢复网络不自动POST。',['../android/app/src/main/java/dev/notifier/app/ResponseDrafts.kt'],['response.post','response.get'])
node('A.cache','A','离线窗口与体验','加密缓存、完整页预算、导航和忙态反馈。',['../android/app/src/main/java/dev/notifier/app/OfflineInbox.kt'])
node('A.cache.local','A.cache','缓存与草稿边界','保留原未知/workspace，六处缓存GET不拆身份门。',['../android/app/src/main/java/dev/notifier/app/PrivateInbox.kt','../android/app/src/main/java/dev/notifier/app/ReadOnlyAutoSync.kt'],['cache.protocol'],[gap('evidence','原Compose大缓存/取消/重开证据须按原任务核对，不迁签H5或WebView。新端缓存、序列化/渲染与平台性能仍需实际测量，不能把更换H5当自动修复。','requirements.md#8-非功能约束与待量化项'),gap('implementation','此处Android加密缓存/草稿代码是历史参照；H5持久离线能力需自己的实现落点，不能从原Kotlin文件存在推出。','decisions.md')])
node('A.future','A','新对话与丰富交互','主动创建、媒体、复杂卡片需要真实合同，不摆假按钮。',gaps=[gap('contract','客户端须先取得权威来源/epoch/创建能力，以及媒体和版本化动作合同。现有事件回应不能代替。','requirements.md#61-后续客户端能力的服务端合同前提')],scope='扩展')
node('A.future.entry','A.future','客户端所需新能力','新建专用会话、附件/图片/语音和复杂表单按能力开放。',apis=['new.conversation','media.contract','card.contract'],docs=['requirements.md#61-后续客户端能力的服务端合同前提'])

# B: public ledger
node('B.events','B','事件与原事件更新','稳定请求ID、预期版本、历史和通知意图同事务。',['../server/src/core.ts'])
node('B.events.contract','B.events','创建 / 更新 / 历史','来源只能在自己作用域发布；后续结果仍归原事件。',['../server/src/contracts.ts','../server/src/routes.ts'],['events.create','events.update','events.history','events.get'])
node('B.responses','B','回应与动作占用','互斥选项共享动作实例；回应不自行选择路由目标。',['../server/src/core.ts'])
node('B.responses.contract','B.responses','保存回应与资格查询','已保存、等待、blocked与已知原生收件分别保留。',['../server/src/contracts.ts'],['response.post','response.get','source.responses'])
node('B.facts','B','用户决定与变更同步','已读/完成/停止跟踪独立于来源自报结果。',['../server/src/routes.ts'])
node('B.facts.contract','B.facts','阅读 / 事项 / 同步边界','创建顺序分页不是更新订阅或全库变更游标。',['../server/src/routes.ts'],['read.put','disposition.post','events.list','sync.proposal'],[gap('contract','完整变更同步需覆盖事件更新、回应、已读和配置及游标失效重建；当前GET events仅按创建顺序分页。','../server/README.md')])

# C: identity
node('C.scope','C','认证与来源作用域','owner、actor、source、epoch及当前能力一并核验。',['../server/src/auth.ts'])
node('C.scope.binding','C.scope','来源自查与绑定约束','GET不是最终写许可，旧幂等ACK前仍须核当前scope。',['../server/src/source-binding.ts'],['source.self','binding.protocol'],[gap('evidence','这些入口在本地源码有落点，其可消费版本/独审和联合发布边界须读取路线，不从文件存在推出稳定可用。','roadmap.md')])
node('C.pair','C','设备配对','一次性邀请、原claim事实和安装namespace。',['../server/src/device-store.ts'])
node('C.pair.contract','C.pair','配对与原事实查询','包/提议token/原ID先持久；401/404不证明未执行。',['../server/src/device-routes.ts','../android/app/src/main/java/dev/notifier/app/DeviceIdentity.kt'],['pair.claim','device.self','device.claim'])
node('C.lifecycle','C','轮换 / 撤销 / 管理','身份转换保原未决，撤销不取消未知外部效果。',['../server/src/device-authority.ts'])
node('C.lifecycle.contract','C.lifecycle','精确身份转换回执','同设备新凭据须核原request及版本，不借同owner身份继承。',['../server/src/device-routes.ts'],['device.rotate','device.transition','device.revoke','device.revocation','device.selfrevoke','devices.list','invite.create','invite.revoke'])

# D: notifications
node('D.register','D','设备通知登记','端点与安装/注册代次分离，不默认公开主题。',['../server/src/notification-routes.ts'])
node('D.register.contract','D.register','推送登记与读取','当前设备只管理自己的登记，端点受批准origin约束。',['../android/app/src/main/java/dev/notifier/app/PushSettings.kt'],['push.get','push.put'])
node('D.deliver','D','通知投递与分层回执','平台接受、设备收到、OS请求及可见不是同一层。',['../server/src/notifications.ts'])
node('D.deliver.contract','D.deliver','ntfy → UnifiedPush → OS','最少引用载荷，认证nonce/事件映射后取权威内容。',['../android/app/src/main/java/dev/notifier/app/PushWorkers.kt','../android/app/src/main/java/dev/notifier/app/PushProtocol.kt'],['notification.list','notification.receipt','push.protocol'],[gap('evidence','模拟器/软件证据不覆盖物理设备、厂商后台/锁屏、目标网络及用户真实可见；需按A04/A05及路线核验对应矩阵。','acceptance.md#31-真机锁屏后台a04a05')])
node('D.policy','D','静默 / 隐私 / 合并','提醒策略不吞已保存事件或新动作。',['../android/app/src/main/java/dev/notifier/app/NoticePreferences.kt'])
node('D.policy.local','D.policy','本机偏好与共享规则','本机静默不等于共享方案或多设备配置同步。',['../android/app/src/main/java/dev/notifier/app/PrivateNoticePreferences.kt'],['notice.protocol'],[gap('contract','跨设备偏好、通知合并和重要性规则需与工作方式、版本同步明确衔接，不能从本机偏好外推。','plugins.md')])

# E: exact delivery
node('E.claim','E','命令领取与查询','原回应派生唯一命令；领取即保守未知，不用租约重发。',['../server/src/delivery.ts'])
node('E.claim.contract','E.claim','原命令事实接口','validate只是资格查询，不授原生输入权。',['../server/src/delivery-routes.ts'],['command.claim','command.get','command.validate'])
node('E.native','E','最终原生提交门','当前权限/期限/目标/修订/单活和去重在提交边界核验。',['../server/src/source-adapter.ts'])
node('E.native.gate','E.native','同步NativeHost门','持久attempted/unknown后，在同步门内接受原native输入并同步回执。',['../server/src/delivery.ts','../pi-host/src/native.ts'],['native.gate'],[gap('evidence','每种真实来源必须证明准确原生身份、提交竞态和收件；HTTP预检或观察索引不能作为证据替身。','acceptance.md#32-原会话真实收件a03a13a14')])
node('E.receipts','E','原收件 / 结果 / 未知对账','只查询原command，不换ID或目标重发未知效果。',['../server/src/source-adapter.ts'])
node('E.receipts.contract','E.receipts','关联收件与原事件更新','来源报告不是执行完成或独立验收，迟到收件不重开事项。',['../server/src/delivery-routes.ts'],['command.receipt','command.update','command.get'])

# F: sources & model host
node('F.host','F','来源适配与独立App宿主','HTTP程序和可选专用Pi会话接入公共账本。',['../pi-host/src/runtime.ts','../pi-host/src/native.ts'])
node('F.host.protocol','F.host','Pi App生命周期与窄工具','不发现旧工作会话；/send是渠道发送而非AI输入。',['../pi-host/src/main.ts'],['host.protocol','question.protocol'],[gap('implementation','其他AI/作业写回需各自适配器及精确提交/回执落点；此专用SDK入口不是任意现有进程接管器。','plugins.md')])
node('F.model','F','模型许可与来源观察','配置位、原生收件、模型请求和完整来源结果分开。',['../pi-host/src/model-budget.ts','../pi-host/src/credentials.ts'])
node('F.model.protocol','F.model','持久预算 / 只读授权 / 运行信息','未知不退款，重启不重置；观察GET不触发模型。',['../server/src/source-runtime.ts','../pi-host/src/identity.ts'],['source.runtime','model.protocol'],[gap('decision','日常持续真实模型使用须明确范围/预算与可承担费用，不能从有界测试或示例预算继承许可。','decisions.md')])
node('F.new','F','主动新对话与助理替换','专用新会话先持久分配，公共配置/记录不随助理消失。',scope='扩展')
node('F.new.contract','F.new','权威来源目录与创建事实','稳定创建请求可查询原结果；不转移旧命令或未知效果。',apis=['new.conversation','assistant.proposal'],gaps=[gap('contract','用户可见来源/epoch、可创建能力及创建/查询事实合同尚需制定；source/self只供source自查。','requirements.md#61-后续客户端能力的服务端合同前提'),gap('implementation','助理无关共享摘要/替换流程在设计中有职责，已核模块未找到完整公共实现入口；不是全仓穷尽审查。','architecture.md#7-助理记忆替换')])

# G: connector
node('G.publish','G','稳定原包与主动出站','脚本JSON入队，scope绑定后重放同一数据库发布包。',['../connectors/src/transport.mjs','../connectors/src/validation.mjs'])
node('G.publish.protocol','G.publish','spool → self → 双带发布','connector_persisted不是event_saved，更不是source_received。',['../connectors/src/spool.mjs'],['spool.protocol','source.self','binding.protocol','events.create','events.update'])
node('G.observe','G','Uniflo快照与流','显式选择、水位/映射/outbox同事务，断流标gap。',['../connectors/src/uniflo.mjs'])
node('G.observe.protocol','G.observe','只读上游协议','首连基线，快照补当前状态；不上传正文或以idle判完成。',['../connectors/src/uniflo.mjs'],['uniflo.health','uniflo.snapshot','uniflo.stream'],[gap('evidence','固定公开daemon与合成布局不覆盖实际agent/live-PID、私人会话、所有harness/OS；适用证据按路线核对。','../connectors/README.md')])
node('G.storage','G','容量 / 诊断 / 存储维护','背压不删unknown/pending或原ID事实。',['../connectors/src/spool-capacity.mjs','../connectors/src/spool-format.mjs'])
node('G.storage.protocol','G.storage','逻辑保留与只读聚合','SQL可见saved不证明当前fsync成功；status不授发布权。',['../connectors/src/spool.mjs'],['spool.status'],gaps=[gap('evidence','扩容/归档与旧快照当前性不是同一问题；新存储合同和故障原子性需按任务/适用版本核对。','tasks/connector-004-storage-lifecycle.md')])
node('G.storage.maintain','G.storage','不遗忘的扩容与归档','维护保留全局ID/seq、FIFO、回执及映射；不迁移授权。',['../connectors/src/spool-maintenance.mjs','../connectors/src/spool-storage.mjs'],['storage.protocol'],gaps=[gap('contract','跨旧快照恢复、凭据轮换不能靠健康检查/旧PID自证当前性；本地图不提供恢复或重新发送授权。','tasks/connector-004-storage-lifecycle.md')])

# H: workflows
node('H.rules','H','默认通知与只读跟办','发生什么、影响、下一步、是否需要用户、证据级别。',scope='首轮薄配置 / 扩展')
node('H.rules.proposal','H.rules','声明式触发与跟踪','普通进展静默、待决不误合并；自动催办/执行另需授权。',apis=['workflow.proposal'],gaps=[gap('implementation','规则/持续跟办在plugins中是语义提案；现有通知偏好和事项决定不能等同完整工作方式引擎。','plugins.md#6-默认项目助理方案')])
node('H.templates','H','模板与快捷回复','本机输入辅助与共享模板库分开。',['../android/app/src/main/java/dev/notifier/app/ResponseDrafts.kt'])
node('H.templates.local','H.templates','本机模板到共享方案的边界','插入不发送，修改模板不改已有草稿；共享需另有版本/同步合同。',['../android/app/src/main/java/dev/notifier/app/DraftSettings.kt'],['draft.protocol'],[gap('contract','服务端模板/工作方式配置同步、版本和导入差异不能由当前本机快捷回复API补造。','plugins.md')])
node('H.share','H','分享 / 依赖 / 助理无关配置','导入槽位配置，不导入有效授权或私人实例。',scope='扩展')
node('H.share.proposal','H.share','方案包与权限差异','方案保留偏好/模板/历史，旧命令不重建不转移。',apis=['workflow.proposal','assistant.proposal'],gaps=[gap('contract','包版本、依赖兼容、导入差异和逐项能力确认是提案合同，不是现成安装器。','plugins.md'),gap('decision','可视化编排、插件市场及原生兼容属于后续候选，不默认为首轮。','requirements.md#7-第一轮范围与后续候选')])

# I: extension / media
node('I.plugins','I','受控扩展与生命周期','来源/助理/记忆/规则/通知/工具扩展点，先薄接口。',scope='扩展')
node('I.plugins.proposal','I.plugins','启停 / 依赖 / 兼容与隔离','同进程能力清单不是强沙箱；停用保留未知旧交付。',apis=['plugin.proposal'],gaps=[gap('implementation','plugins.md候选Plugin方法不是发布SDK；已核目录没有完整插件装载/管理实现入口。','plugins.md'),gap('decision','动态运行模型、打包/隔离/签名与DSH兼容需决策，不能继承Fastify插件或Pi资源加载。','decisions.md')])
node('I.memory','I','外部记忆与共享摘要','摘要/检索不代管唯一账本、权限或原始回执。',scope='扩展')
node('I.memory.proposal','I.memory','记忆后端与范围','带来源/时间/可见范围，断开可降级，不把摘要当运行事实。',apis=['memory.proposal'],gaps=[gap('decision','外部记忆后端D06未选择；允许后置，不阻断公共事件保存。','decisions.md#2-仍待决定'),gap('implementation','已核模块未定位通用记忆接入实现；资源目录中的memory引用也不等于检索/保存后端。','plugins.md')])
node('I.tools','I','受控工具与MCP执行','资源可见/启用不授执行权，工具仍核实际操作范围和当前许可。',scope='扩展')
node('I.tools.proposal','I.tools','工具参数与执行/回执边界','预注册操作、授权/预算、稳定原请求和未知只查。',apis=['tool.proposal'],gaps=[gap('implementation','当前宿主窄app_question工具不是任意工具/MCP执行器；通用受控执行的实现落点与安全合同须另明确。','../pi-host/README.md')])
node('I.media','I','媒体对象与版本化卡片','上传/取回/保留与组件schema，是跨端合同而非几个按钮。',scope='扩展')
node('I.media.proposal','I.media','媒体和复杂交互合同','owner/事件绑定、MIME/字节/完整性、过期撤销与重新确认。',apis=['media.contract','card.contract'],gaps=[gap('contract','现有button/text不能承载上传和复杂结构化提交；需真实对象、动作实例与版本合同，尚不命名新HTTP路径。','requirements.md#61-后续客户端能力的服务端合同前提')])

# J: operations
node('J.run','J','部署 / 保活 / 诊断','配置、TLS、私有访问、来源暂停与真实等待原因。',['../server/src/main.ts','../pi-host/src/main.ts'])
node('J.run.protocol','J.run','健康与来源运行观察','health只证明数据库；paused不清原收件/unknown。',['../server/src/app.ts','../server/src/source-runtime.ts'],['health.get','source.runtime','host.protocol'],[gap('implementation','显式模型启动不可用自动保HTTP与既有手动source-paused不同；前者只有任务草稿，不从手动模式推出实现。','tasks/backend-next-model-degraded-http.md')])
node('J.recover','J','备份 / 冻结 / 当前性对账','离线加密材料、原路径冻结与受限计划交接分开。',['../pi-host/src/backup-cli.ts','../pi-host/src/restore-cli.ts','../pi-host/src/handoff-cli.ts'])
node('J.recover.protocol','J.recover','备份与恢复专用入口','文件可读不重建旧ACK；旧快照不是当前授权/未执行证明。',['../server/src/recovery-gate.ts'],['backup.protocol','restore.protocol','handoff.protocol'],[gap('contract','连续活源见证的禁模型交接不是一般cold恢复解冻；备份后未知/撤销/预算当前性仍需可信对账合同。','../pi-host/README.md'),gap('evidence','完整A27与生产恢复目标不能由材料验证或CLI存在推出；应核路线所绑定的候选/层级。','acceptance.md#36-恢复旧备份a27')])
node('J.release','J','生命周期 / 构建 / 分发','容量/保留、兼容升级、正式签名、许可和支持矩阵。',scope='日常 / 扩展')
node('J.release.protocol','J.release','公开构建与运行支持','源码公开、APK构建、正式分发与生产运行分别核对。',code=['../server/package.json','../pi-host/package.json','../android/app/build.gradle.kts','../connectors/package.json'],apis=['build.protocol'],gaps=[gap('decision','产品名称/标识、许可证D07/D08及安卓分发/真实覆盖D10仍需相应决定；不以依赖许可替代。','decisions.md#2-仍待决定'),gap('evidence','Node/SQLite、设备/网络/来源实际组合需各自证据，不把组件最低版本声明或一个测试环境外推。','roadmap.md')])

# Actual local HTTP contracts. Paths and fields are from module READMEs / strict routes.
api('events.list','GET','/v1/events','事件分页','after, limit；Bearer作用域','items,next_after；创建顺序分页','不是变更同步游标，也不是跨页一致快照。','../server/src/routes.ts','B.events.contract',['A.inbox.read','G.publish.protocol'])
api('events.get','GET','/v1/events/{id}','事件详情','原event_id；当前认证','当前版本、交互、已读/资格和分层回执','缓存或can_respond不是实际提交许可。','../server/src/core.ts','B.events.contract',['A.inbox.read','A.respond.contract'])
api('events.create','POST','/v1/events','创建事件','request_id,title,body,session_ref,target_revision,expires_at；可选interaction','event_id,event_version,saved_at','source publish；幂等/历史/意图同事务。只证明服务保存。','../server/src/contracts.ts','B.events.contract',['F.host.protocol','G.publish.protocol'])
api('events.update','POST','/v1/events/{id}/updates','原事件更新','update_id,expected_event_version,kind,body；可选目标修订/交互','原event_id及新版本/保存时间','准确原source/epoch；结果仍source_result_reported，不自动完成。','../server/src/contracts.ts','B.events.contract',['F.host.protocol','G.observe.protocol'])
api('events.history','GET','/v1/events/{id}/history','历史分页','原event_id,after,limit','按提交seq追加的items,next_after','历史seq不等于item offset，后来的摘要不覆盖事实。','../server/src/routes.ts','B.events.contract',['A.inbox.read','A.cache.local'])
api('response.post','POST','/v1/events/{id}/responses','保存用户回应','response_id,event_version,interaction_id,interaction_version,action_id,text','response_id,event_id,saved_at','user认证；目标来自事件快照，不接受客户端任意地址/会话。保存不是来源收件。','../server/src/contracts.ts','B.responses.contract',['A.respond.contract'])
api('response.get','GET','/v1/responses/{id}','查询原回应','稳定原response_id；当前认证','原回应、当前eligibility/routing、source_delivery','401/404/缺回执不是原操作未执行证明；不新建替代ID。','../server/src/core.ts','B.responses.contract',['A.respond.contract','A.inbox.read'])
api('source.responses','GET','/v1/source/responses','来源只读回应','当前准确source read_responses；after,limit','自己的当前代次回应分页','只读查询不是命令领取或Native输入。','../server/src/routes.ts','B.responses.contract',['F.host.protocol'])
api('read.put','PUT','/v1/events/{id}/read-state','明确阅读','event_version；owner用户','event_id,read_version','单调阅读水位，不关闭交互或声称已执行。','../server/src/contracts.ts','B.facts.contract',['A.inbox.read'])
api('disposition.post','POST','/v1/events/{id}/disposition','事项决定','request_id,expected_event_version,disposition','event_id,event_version,saved_at','open/paused/completed/not_tracking；不取消已有外部效果。','../server/src/contracts.ts','B.facts.contract',['A.inbox.read'])
api('source.self','GET','/v1/source/self','来源身份自查','source Bearer，无额外query','id,owner_id,source_id,source_epoch,capabilities,binding_protocol:1','仅source，no-store；不是用户来源目录或最终发布许可。','../server/src/source-binding.ts','C.scope.binding',['G.publish.protocol'])
api('pair.claim','POST','/v1/pairing/claim','认领邀请','store_id,claim_id,invitation_id,secret,proposed_token','claim_id,device_id,store_id','原secret与提议token先私下持久；owner/角色来自邀请，不由正文自选。','../server/src/device-routes.ts','C.pair.contract',['A.respond.contract'])
api('device.self','GET','/v1/device/self','当前设备','当前受管user Bearer','store_id,device_id,owner_id,label,manage_devices,credential_version','不返回token；只证明本次身份观察。','../server/src/device-routes.ts','C.pair.contract',['A.respond.contract'])
api('device.claim','GET','/v1/device/claims/{id}','原claim事实','当前设备及原claim ID','自身原认领事实','历史接受不代表另一身份可继承原未决。','../server/src/device-routes.ts','C.pair.contract',['A.respond.contract'])
api('device.rotate','POST','/v1/device/rotate','凭据轮换','request_id,replacement_token','原设备/旧新版本的转换事实','先保存整个意图，ACK未知查原replacement，不生成替代。','../server/src/device-routes.ts','C.lifecycle.contract',['A.respond.contract'])
api('device.transition','GET','/v1/device/transitions/{id}','原轮换查询','原replacement认证＋request ID','store/owner/device/旧新摘要/版本','仅精确匹配才延续namespace，不把摘要当新权限。','../server/src/device-routes.ts','C.lifecycle.contract',['A.respond.contract'])
api('device.revoke','POST','/v1/device/revoke','撤销设备','request_id,device_id','原撤销事实','普通设备仅自身；同owner管理员才可管理其他设备。','../server/src/device-routes.ts','C.lifecycle.contract',['A.respond.contract'])
api('device.revocation','GET','/v1/device/revocations/{id}','原issuer撤销查询','当前issuer＋原request ID','原target/request/owner/revoked','不借另一设备身份或另一新请求推断。','../server/src/device-routes.ts','C.lifecycle.contract',['A.respond.contract'])
api('device.selfrevoke','POST','/v1/device/self-revocation-receipt','窄自撤销事实查询','原旧Bearer；request_id,device_id','该精确原自撤销事实','不是通用认证豁免，找不到不能认为未发生。','../server/src/device-routes.ts','C.lifecycle.contract',['A.respond.contract'])
api('devices.list','GET','/v1/devices','同owner设备','受管user当前认证','标签/状态/版本/管理能力','不返回凭据或摘要。','../server/src/device-routes.ts','C.lifecycle.contract',['A.respond.contract'])
api('invite.create','POST','/v1/device/invitations','创建邀请','request_id,invitation_id,secret,owner_id,label,manage_devices,expires_at','邀请操作事实','当前管理员；secret在调用前私下保存，不用URL/日志供应。','../server/src/device-routes.ts','C.lifecycle.contract',['A.respond.contract'])
api('invite.revoke','POST','/v1/device/invitations/{id}/revoke','撤销邀请','原邀请ID及request_id','原撤销事实','不等于撤销已经成功配对的设备。','../server/src/device-routes.ts','C.lifecycle.contract',['A.respond.contract'])
api('push.get','GET','/v1/device/push','读取设备推送登记','当前用户设备','configured,generation,registration_id,registered','不返回完整endpoint；仍须当前origin批准。','../server/src/notification-routes.ts','D.register.contract',['A.inbox.read'])
api('push.put','PUT','/v1/device/push','登记/停用推送','registration_id,expected_generation,endpoint或null','登记事实/代次','固定批准origin/原设备，不能改投旧通知受众。','../server/src/notification-routes.ts','D.register.contract',['A.inbox.read'])
api('notification.list','GET','/v1/notifications','通知诊断','当前设备；after,limit','delivery/event/version及平台/设备/OS报告','没有当前版本记录时不能继承旧版posted。','../server/src/notification-routes.ts','D.deliver.contract',['A.inbox.read'])
api('notification.receipt','POST','/v1/notifications/{id}/receipt','设备通知报告','nonce,state:device_received或notification_posted','原delivery/event/version/state/observed_at/evidence','当前准确设备＋nonce；posted不证明用户看到/已读。','../server/src/notification-routes.ts','D.deliver.contract',['A.inbox.read'])
api('command.claim','POST','/v1/source/commands/claim','领取原命令','claim_id；准确source deliver/read_responses/reply','command或null；原claim重放原结果','领取即effect_unknown，没有租约到期自动重发。','../server/src/delivery-routes.ts','E.claim.contract',['F.host.protocol'])
api('command.get','GET','/v1/source/commands/{id}','查询原命令','准确原source/epoch及command_id','当前命令与原回执事实','只查不交付。','../server/src/delivery-routes.ts','E.claim.contract',['F.host.protocol','E.receipts.contract'])
api('command.validate','POST','/v1/source/commands/{id}/validate','资格投影','原command ID及空对象','当前资格，execution_authorized:false','不是输入许可，不替代最终Native门。','../server/src/delivery-routes.ts','E.claim.contract',['F.host.protocol'])
api('command.receipt','POST','/v1/source/commands/{id}/receipt','关联原生收件','receipt_id,command_id,session_ref,state_revision,message_id','不可替换的原命令/原生关联事实','只证明受信适配器所报原生收件，不证明执行或独立验收。','../server/src/delivery-routes.ts','E.receipts.contract',['F.host.protocol'])
api('command.update','POST','/v1/source/commands/{id}/updates','命令关联结果','原update字段＋已有原命令原生回执','原event/command/response关联更新','需publish，不可换命令关联，迟到进展不重开用户事项。','../server/src/delivery-routes.ts','E.receipts.contract',['F.host.protocol'])
api('source.runtime','GET','/v1/source-runtime/{source_id}','受信运行观察','user认证；event_id,event_version','准确source/epoch的state/reason/observed_at及许可配置位','观察不触发SDK或模型；running不是下一输入/模型授权。','../server/src/source-runtime.ts','F.model.protocol',['A.inbox.read','J.run.protocol'])
api('health.get','GET','/health','账本健康','无业务身份参数','status/storage','只检查数据库可查询，不证明鉴权、链路、手机或模型可用。','../server/src/app.ts','J.run.protocol',['A.inbox.read'])
api('uniflo.health','GET','/v1/health','Uniflo schema健康','固定回环origin及独立Bearer','ok,schema:1,seq','上游API，不是本事件服务/health。','../connectors/src/uniflo.mjs','G.observe.protocol',['G.observe'],protocol='Uniflo 固定公开协议')
api('uniflo.snapshot','GET','/v1/sessions/{key}','显式来源快照','管理员明确选择的key','snapshot及x-uniflo-seq','观察键不是原生写回身份；不扫描/发现私人目录。','../connectors/src/uniflo.mjs','G.observe.protocol',['G.observe'],protocol='Uniflo 固定公开协议')
api('uniflo.stream','GET','/v1/stream.ndjson','只读实时流','since,session,types,max_text','hello与NDJSON session/event/removed','hello head不跳过backlog；gap只补当前快照，不补称完整历史。','../connectors/src/uniflo.mjs','G.observe.protocol',['G.observe'],protocol='Uniflo 固定公开协议')

def proto(id,title,inp,out,boundary,code,to,callers):
 api(id,'本地/协议',title,title,inp,out,boundary,code,to,callers,protocol='本地调用 / 协议边界',kind='protocol')
proto('binding.protocol','发布作用域绑定','固定四元组摘要；POST头x-notionapp-source-binding与正文source_binding同值','核验后从业务副本剥离，原业务幂等摘要不变','摘要不替Bearer/权限/当前库权威；不能去约束降级重发。','../server/src/source-binding.ts','C.scope.binding',['G.publish.protocol'])
proto('cache.protocol','Android安全缓存','原namespace、合法缓存/游标/预算、显式导航/清理确认','AES-GCM/AtomicFile读模型；原workspace/未知槽保留','六处GET完整持有cacheMonitor→ConnectionGate；本机缓存不是新授权。','../android/app/src/main/java/dev/notifier/app/OfflineInbox.kt','A.cache.local',['A.inbox','A.respond'])
proto('draft.protocol','本机草稿与快捷回复','显式保存原问题/动作/文字，或插入快捷文字','本机待提交；再次在线核对/确认后移入原Pending','不自动发、不创建第二回应队列；共享模板不由此自动具备。','../android/app/src/main/java/dev/notifier/app/ResponseDrafts.kt','H.templates.local',['A.respond'])
proto('notice.protocol','本机通知偏好','总开关/隐私/静默时段/当前namespace来源规则','本机抑制/OS渠道观察，与通知回执分开','静默不撤销来源效果，重新启用不补发旧版本。','../android/app/src/main/java/dev/notifier/app/NoticePreferences.kt','D.policy.local',['A.inbox'])
proto('push.protocol','ntfy / UnifiedPush / OS','最小event_id,event_version,delivery_id,nonce载荷','平台接受；设备关联报告；OS请求各自事实','不含正文/原生会话/服务凭据，未知不跨渠道盲重放。','../server/src/notifications.ts','D.deliver.contract',['B.events.contract'])
proto('native.host','NativeHost.compareAndEnqueue / getReceipt','不可变原command及当前时间，或准确原command_id','command_id,session_ref,state_revision,message_id；缺事实保持未知','synchronousDurableGate，原身份CAS和持久去重/原生fsync先于回执；不得异步排队或网络代写。','../server/src/delivery.ts','F.host.protocol',['E.native.gate','E.receipts.contract'])
proto('native.gate','DeliveryStore.submitAtGate','原命令/不可变回应快照/当前权限与准确NativeHost','持久原native entry关联与公共receipt','同步最终门不可await网络；未知只查原command，不换ID重发。','../server/src/delivery.ts','E.native.gate',['F.host.protocol','E.claim.contract'])
proto('host.protocol','Pi App init / serve / status / preflight','操作者明确的私有App配置和专用原路径','专用SDK会话、HTTP账本及安全运行观察','不发现现有聊天/资源；默认不调用模型，不接管生产或同名进程。','../pi-host/src/main.ts','F.host.protocol',['J.run.protocol'])
proto('question.protocol','app_question 窄工具','一个有界问题意图及button/text动作','原事件问题或原命令关联新问题','没有shell/文件/MCP/任意目标参数，不是通用执行器。','../pi-host/src/runtime.ts','F.host.protocol',['F.model.protocol'])
proto('model.protocol','持久模型请求边界','明确身份/模型/授权、原run与持久请求预算','request intent / HTTP attempt / response /完整输出分别记账','只读CredentialStore无ambient回退，未知不返还，不自动refresh。','../pi-host/src/runtime.ts','F.model.protocol',['F.host.protocol'])
proto('spool.protocol','enqueue / flush / run / observe','严格脚本create/update或只读观察，固定scope和原包','本地传输持久事实、服务ACK与映射','publish-only，无命令领取/Native输入；原包重放只适用于数据库发布。','../connectors/src/cli.mjs','G.publish.protocol',['F.host','G.observe'])
proto('spool.status','status 只读聚合','准确私有路径与binding，受限SQL snapshot或stat-only','有界计数/保留/物理文件与等待原因','SQL只读非物理零写，可读saved非fsync/新ACK；不授发布。','../connectors/src/spool.mjs','G.storage.protocol',['J.run'])
proto('storage.protocol','upgrade / resize / archive-plan / archive','原绑定/原库/单写者；本地限额或归档选项JSON，具体以任务/源码为准','原ID/seq/FIFO/回执不遗忘的维护事实','格式升级/归档不是旧快照恢复许可；不得归档pending/unknown来跳过。','tasks/connector-004-storage-lifecycle.md','G.storage.maintain',['J.recover'])
proto('backup.protocol','backup-create / inspect / stage','显式离线专用App、独立密钥与新材料路径','认证加密容器或不可执行惰性材料','不自动纳入所有外部引用，不开启SDK/模型/输入；可读不补旧耐久ACK。','../pi-host/src/backup-cli.ts','J.recover.protocol',['J.recover'])
proto('restore.protocol','restore-install / status','原认证archive/key、操作员原路径scope及原intent','原路径冻结安装和受限只读状态','不解冻/不重发，旧快照active/余额不是当前权利。','../pi-host/src/restore-cli.ts','J.recover.protocol',['J.recover'])
proto('handoff.protocol','受限连续计划交接','备份前已确定的同一活primary/原操作/禁模型资格','有授权才按原操作前向补屏障/观察','不是cold恢复授权器；当前Native完整性和原预算不能忽略或重置。','tasks/T014-matching-state-model-disabled-enable.md','J.recover.protocol',['J.recover'])
proto('build.protocol','各模块锁定构建入口','公开源码、package/lock或Gradle配置、对应工具链','本轮构建产物与可核来源','构建不等正式签名/渠道分发/物理验收；各运行组合分别核对。','engineering-map.md','J.release.protocol',['J.release'])
proposal('new.conversation','专用新会话创建与原事实查询','权威来源目录/epoch/创建能力、稳定请求、先持久分配再执行','F.new.contract',['A.future.entry'],'requirements.md#61-后续客户端能力的服务端合同前提')
proposal('sync.proposal','完整变更同步','事件/回应/已读/配置的权威游标、过期重建，不是创建分页','B.facts.contract',['A.inbox.read'],'protocol-draft.md')
proposal('workflow.proposal','工作方式/方案包','版本、依赖、触发/规则/模板、受限跟踪与导入差异','H.share.proposal',['H.rules.proposal'],'plugins.md')
proposal('assistant.proposal','助理替换与共享摘要','公共配置/历史/带范围摘要保留；原命令与授权不转移','F.new.contract',['H.share.proposal'],'architecture.md#7-助理记忆替换')
proposal('plugin.proposal','插件生命周期','manifest/config/register/start/health/stop/dispose语义；运行模型另定','I.plugins.proposal',['H.share.proposal'],'plugins.md')
proposal('memory.proposal','记忆检索/保存','受限范围、来源/时间/版本与可降级错误；不是唯一账本','I.memory.proposal',['F.new.contract'],'plugins.md')
proposal('tool.proposal','受控工具/API/MCP','预注册能力、参数、资源范围、当前授权与未知效果查询','I.tools.proposal',['F.host.protocol'],'plugins.md')
proposal('media.contract','媒体对象上传/取回/保留','owner/event归属、能力/MIME/字节/完整性、旧版本/过期/撤销拒绝','I.media.proposal',['A.future.entry'],'requirements.md#61-后续客户端能力的服务端合同前提')
proposal('card.contract','版本化复杂卡片提交','schema版本、动作实例、结构化提交/资格/重新确认','I.media.proposal',['A.future.entry'],'requirements.md#61-后续客户端能力的服务端合同前提')

# Cross-system contracts, not network topology or progress.
def edge(id,src,dst,title,apis,boundary): EDGES.append(dict(id=id,source=src,target=dst,title=title,apis=apis,boundary=boundary,kind='dependency'))
edge('web-ledger','A.web.client','B.events.contract','H5复用既有API',['events.list','events.get','events.history','response.post','response.get'],'消费目标，不重做后端；既有接口存在不证明Web已实现或已通过。')
edge('shell-notice','A.native.bridge','D.deliver.contract','壳接原生通知',['shell.proposal','push.protocol'],'桥接为待落实语义；原Compose/浏览器前台不代新壳后台、锁屏和安全存储证据。')
edge('a-b','A.inbox.read','B.events.contract','读取当前事件',['events.list','events.get','events.history'],'推送/缓存不是权威，分页不是变更同步。')
edge('reply','A.respond.contract','B.responses.contract','保存原回应',['response.post','response.get'],'返回保存事实，不返回执行成功。')
edge('device','A.device.client','C.pair.contract','当前设备身份',['pair.claim','device.self'],'身份未知不换包/换token绕过原请求。')
edge('notify','B.events.contract','D.deliver.contract','持久通知意图',['push.protocol'],'平台/设备/OS/已读各自表达。')
edge('push-app','D.deliver.contract','A.inbox.read','取权威卡片',['notification.receipt','events.get'],'nonce映射核验，不制造已读。')
edge('command','B.responses.contract','E.claim.contract','原回应派生命令',['command.claim','command.get'],'原目标和输入不可偷偷替换。')
edge('native','E.native.gate','F.host.protocol','准确原生输入',['native.host'],'仅已验证的原生提交能力，不是HTTP validate。')
edge('receipt','F.host.protocol','E.receipts.contract','原收件及结果',['command.receipt','command.update'],'来源结果不是独立验收。')
edge('publish','G.publish.protocol','B.events.contract','稳定原包发布',['events.create','events.update'],'本地持久与服务ACK分开。')
edge('binding','G.publish.protocol','C.scope.binding','末次scope约束',['source.self','binding.protocol'],'GET探测不代写门，双带不能降级。')
edge('runtime','A.inbox.read','F.model.protocol','关联运行观察',['source.runtime'],'running不等下一输入获准。')
edge('rules','H.rules.proposal','D.policy.local','提醒与跟踪策略',['workflow.proposal'],'提案的共享规则不从本机偏好推导。')
edge('newdialog','A.future.entry','F.new.contract','主动新对话合同',['new.conversation'],'原回应不能创建新目标；合同未冻结。')
edge('media','A.future.entry','I.media.proposal','媒体与卡片合同',['media.contract','card.contract'],'提案，不编路径或借text传附件。')
edge('memory','F.new.contract','I.memory.proposal','受范围约束摘要',['memory.proposal','tool.proposal'],'摘要和模型建议不扩大授权。')
edge('replace','H.share.proposal','F.new.contract','保留公共配置',['assistant.proposal'],'替换助理不移交在途命令。')
edge('recover','J.recover.protocol','E.receipts.contract','未知与回执对账',['command.get','restore.protocol'],'旧快照不能自证备份后没执行。')
edge('capacity','J.run.protocol','G.storage.protocol','有界存储诊断',['spool.status'],'诊断不是新的耐久ACK或来源在线。')

PATHS=[
 dict(id='roundtrip',title='云端事件 → 手机回应 → 原来源',summary='首轮业务目标：H5现有API流程与安卓平台通知/真实来源分层，不从节点齐全推出已验。',steps=[['F.host.protocol','events.create'],['B.events.contract','events.get'],['D.deliver.contract','push.protocol'],['A.respond.contract','response.post'],['E.claim.contract','command.claim'],['E.native.gate','native.gate'],['E.receipts.contract','command.receipt']],note='完整证据按A03/A04/A05/A07/A13/A14及路线逐版本、设备和真实来源核对。'),
 dict(id='offline',title='离线 / 丢ACK → 原ID恢复',summary='不以401/404、重启或缺回执推断未执行。',steps=[['A.cache.local','cache.protocol'],['A.respond.contract','response.get'],['B.responses.contract','response.post'],['E.claim.contract','command.get'],['E.receipts.contract','command.receipt']],note='缓存步骤是原Compose历史参照，不表示H5已具备加密缓存；新端另证A09/A10/A11/A28的原ID持久化和未知恢复，读取不授重新执行。'),
 dict(id='local',title='本地观察 → 稳定原包 → 事件',summary='这是publish-only观察路径，不暗示本地AI写回。',steps=[['G.observe.protocol','uniflo.snapshot'],['G.observe.protocol','uniflo.stream'],['G.publish.protocol','spool.protocol'],['C.scope.binding','binding.protocol'],['B.events.contract','events.create']],note='实际agent/用户会话和各OS证据范围见路线；观察成功不接通原生执行。'),
 dict(id='new',title='主动新对话：查合同断点',summary='需求要求的源目录/创建能力和持久分配，不是旧回应API。',steps=[['A.future.entry','new.conversation'],['F.new.contract','new.conversation'],['B.events.contract','events.create'],['E.native.gate','native.gate']],note='提案步骤是合同接缝，需落实创建事实查询、来源能力和先分配后执行，当前不命名新路由。'),
 dict(id='media',title='媒体 / 复杂卡片：跨端边界',summary='对象归属、保留与版本门缺一不可。',steps=[['A.future.entry','media.contract'],['I.media.proposal','media.contract'],['I.media.proposal','card.contract'],['B.responses.contract','response.post']],note='旧text回应不承载附件或复杂提交；最后一个已有入口不能被当作新合同实现。'),
 dict(id='restore',title='备份 → 冻结 → 当前性对账',summary='可读材料、冻结完成和安全重新启用分别判断。',steps=[['J.recover.protocol','backup.protocol'],['J.recover.protocol','restore.protocol'],['E.receipts.contract','command.get'],['J.recover.protocol','handoff.protocol']],note='最后一项仅连续活源禁模型计划交接，不是一般cold解冻。完整A27和当前权利/预算/未知对账另核。')
]
# User reference mechanisms, not approved framework dependencies or imported assistant platform.
node('I.resources','I','资源目录与生命周期','发现/作用域/配置/依赖/启停与真正工具执行分开。',scope='参考候选 / 扩展')
node('I.resources.catalog','I.resources','Magpie资源管理参考','skill、MCP网关、工程memory的显式资源目录与安全引用。',apis=['resource.proposal'],docs=['engineering-map/REFERENCE-CANDIDATES.md'],gaps=[gap('decision','Magpie存在同名项目，准确仓库未唯一定位；需用户链接后核固定版本/许可证/机制，不先选框架。','engineering-map/REFERENCE-CANDIDATES.md'),gap('implementation','现有插件提案有依赖/配置/启停语义，但已核模块未定位专门资源目录。需核发现方式、作用域和停用后原事实保留，不能默认扫描私人目录。','plugins.md')])
node('F.ingress','F','消息入口与精确调度','入口持久去重、分类优先级、原会话和回复回执逐层检查。',scope='参考候选 / 扩展')
node('F.ingress.reference','F.ingress','Prime Agent消息处理参考','多渠道/RSS只作机制候选；不把主助理/分身/调度混成普通回应。',apis=['ingress.proposal'],docs=['engineering-map/REFERENCE-CANDIDATES.md'],gaps=[gap('decision','用户所指prime-agent仓库未确认；PrimeIntellect-ai/prime-agent与ThePrimeagen/prime-agent仅同名候选，未核版本/许可证/实际机制。','engineering-map/REFERENCE-CANDIDATES.md'),gap('contract','现有认证HTTP事件发布可接标准事件，但多渠道标准化/权重过滤/精确调度与返回原入口的回执合同不能从截图推出。分类不能授执行权或丢已承诺事实。','requirements.md'),gap('implementation','worker/chat分身与动态定时是参考问题，不是本App必需服务；若纳入，须定位任务所有权/权限/预算与原ID恢复，不借新会话重派unknown。','engineering-map/REFERENCE-CANDIDATES.md')])
node('F.persona','F','人格与公共事实边界','人格/记忆影响助理表达，不创建系统权限或运行事实。',scope='首轮引用边界 / 扩展')
node('F.persona.boundary','F.persona','人格引用 ≠ 账本/授权','选定人格/模型引用保专用会话身份；共享摘要与原始事实分离。',['../pi-host/src/identity.ts','../pi-host/src/credentials.ts'],['model.protocol','assistant.proposal'],docs=['architecture.md','plugins.md'],gaps=[gap('contract','更换人格/助理、外接记忆和共享摘要的兼容/可见范围需明确；不得复制私人配置或移交旧命令授权。','plugins.md')])
proposal('resource.proposal','资源目录/作用域/配置与启停','显式发现与来源版本、能力可见范围、配置/依赖/健康/启停；执行另经授权','I.resources.catalog',['I.plugins.proposal','I.memory.proposal'],'engineering-map/REFERENCE-CANDIDATES.md')
proposal('ingress.proposal','多入口消息处理与精确分派','入口认证/标准化、持久去重、分类优先级、准确原会话/原请求与返回回执','F.ingress.reference',['H.rules.proposal'],'engineering-map/REFERENCE-CANDIDATES.md')
edge('resources','I.resources.catalog','I.tools.proposal','资源不是执行授权',['resource.proposal','tool.proposal'],'仅候选机制；启用/发现不授实际工具执行权。')
edge('ingress','F.ingress.reference','B.events.contract','入口先保存再分类',['ingress.proposal','events.create'],'多渠道处理是参考候选，现有发布合同不能代精确会话调度。')
edge('persona','F.persona.boundary','C.scope.binding','人格不授系统权限',['model.protocol'],'人格/记忆不能创建用户决定、来源输入许可或真实回执。')
PATHS.append(dict(id='ingress',title='消息入口 → 原会话 → 返回回执',summary='Prime Agent仅参考线索，检查入口/队列/精确调度是否缺合同。',steps=[['F.ingress.reference','ingress.proposal'],['B.events.contract','events.create'],['H.rules.proposal','workflow.proposal'],['E.native.gate','native.gate'],['E.receipts.contract','command.receipt']],note='消息分类/权重不越过权限、持久去重与原会话门；worker/chat分身与定时不默认纳入首轮，未确认框架仓库或API。'))
node('A.device','A','连接与设备设置','配对预览、原身份意图对账、轮换/撤销与当前设备观察。',['../android/app/src/main/java/dev/notifier/app/DeviceSettings.kt'])
node('A.device.client','A.device','设备身份客户端','完整原身份意图与用户pending分槽，核同设备transition才续namespace。',['../android/app/src/main/java/dev/notifier/app/DeviceClient.kt','../android/app/src/main/java/dev/notifier/app/DeviceIdentity.kt'],['pair.claim','device.self','device.claim','device.rotate','device.transition','device.revoke','device.revocation','device.selfrevoke','devices.list','invite.create','invite.revoke'])
for a in APIS.values():
 if a['to'].startswith('C.pair') or a['to'].startswith('C.lifecycle'):
  a['from_']=['A.device.client' if n=='A.respond.contract' else n for n in a['from_']]
next(n for n in NODES if n['id']=='E.receipts.contract')['gaps'].append(gap('contract','来源source_result_reported、原生收件与用户completed都不是独立核验。当前公共投影保持not_verified；独立核验角色/证据关联与记录合同还需明确，不能凭来源报告提升。','../server/README.md'))
next(n for n in NODES if n['id']=='A.inbox.read')['gaps'].append(gap('contract','页面需求建议项目/来源等过滤；当前客户端过滤仅当前缓存区间，固定事件schema没有项目分组合同。项目/关联事项的具体结构与全库查询需后续明确，不在图中编item或搜索API。','requirements.md#6-页面内容要求信息架构建议'))
node('J.candidates','J','后续平台与托管候选','另一手机平台、桌面端、官方托管及多用户组织不作为首轮前置。',scope='后续候选 / 待决定')
node('J.candidates.scope','J.candidates','产品边界尚待选择','保留方向，不从地图节点存在推出承诺或新增必需服务。',docs=['requirements.md#7-第一轮范围与后续候选'],gaps=[gap('decision','上述平台/托管/多用户以及可视化编排/插件市场的优先级未定；正式范围需产品决定，不继承个人部署的授权/隔离假设。','requirements.md#7-第一轮范围与后续候选')])
# Route adjustment adds document targets only; no product code or bridge wire API.
PATHS.append(dict(id='h5',title='H5现有API → 安卓原生壳边界',summary='先运行事件/回应客户端，再接原生平台；后端与业务合同保持。',steps=[['A.web.client','events.list'],['B.events.contract','events.get'],['A.web.client','response.post'],['B.responses.contract','response.get'],['A.native.bridge','shell.proposal'],['D.deliver.contract','push.protocol']],note='壳桥接为语义提案，不冻结库/容器/方法。Compose工程和旧结论保留但不迁签，H5/原生/性能按各自证据验证；本地图不是产品H5 UI。'))
for aid in next(n for n in NODES if n['id']=='A.web.client')['apis']:
 if 'A.web.client' not in APIS[aid]['from_']: APIS[aid]['from_'].append('A.web.client')
for n in NODES:
 if any(p.startswith('../android/') for p in n['code']):
  n['existing']='下列Android/Kotlin入口是原Compose历史参照，不迁签Web或新壳；其他后端落点不因此改变。'+n['existing']
for aid in ['cache.protocol','draft.protocol','notice.protocol']:
 APIS[aid]['title']='原Compose：'+APIS[aid]['title']
 APIS[aid]['boundary']='此为原Compose本机合同，不是Web API或新壳实现。'+APIS[aid]['boundary']
next(n for n in NODES if n['id']=='A')['existing']='客户端按D01/D02/D13改为H5先行、安卓H5＋原生壳。原Compose源码与准确结论保留，不迁签；库/壳细节见实际TASK，执行状态只见路线。'
TASKS_BY_SYSTEM={
 'A':['web-001-event-client.md','T002-android-client.md','T008-offline-inbox.md','android-001-drafts-templates.md','android-002-cache-windows.md','android-003-cache-latency-investigation.md','android-004-cache-read-experience.md'],
 'B':['T001-event-response-store.md','T003-source-delivery.md'],
 'C':['T010-device-pairing-credentials.md','backend-next-source-binding.md'],
 'D':['T004-notifications.md','T009-notification-preferences.md','T006-android-emulator-integration.md'],
 'E':['T003-source-delivery.md','T005-pi-app-runtime.md'],
 'F':['T005-pi-app-runtime.md','T007-mio-live-app.md','T011-source-paused-service.md'],
 'G':['connector-001-outbound-uniflo.md','connector-002-real-uniflo-daemon.md','connector-003-spool-capacity.md','connector-004-storage-lifecycle.md'],
 'H':['android-001-drafts-templates.md','T009-notification-preferences.md'],
 'I':[],
 'J':['T011-source-paused-service.md','T012-encrypted-backup-materials.md','T013-enforced-frozen-restore.md','T014-matching-state-model-disabled-enable.md','backend-next-model-degraded-http.md']}
SHORT_LABELS={'a-b':'事件/回应','reply':'保存回应','device':'设备身份','notify':'通知意图','push-app':'取当前卡','command':'原命令','native':'原生输入','receipt':'关联回执','publish':'原包发布','binding':'scope约束','runtime':'运行观察','rules':'提醒策略','newdialog':'新对话','media':'媒体/卡片','memory':'摘要范围','replace':'公共配置','recover':'未知对账','capacity':'存储诊断','resources':'资源/执行','ingress':'先保存','persona':'人格/授权','web-ledger':'现有API','shell-notice':'原生平台'}
for e in EDGES: e['short']=SHORT_LABELS.get(e['id'],e['title'])
for n in NODES:
 n['docs']=list(dict.fromkeys([*n['docs'],'engineering-map.md',*('tasks/'+p for p in TASKS_BY_SYSTEM[n['system']])]))
next(n for n in NODES if n['id']=='E.native.gate')['apis'].append('native.host')
DATA=dict(systems=[n for n in NODES if n['level']==1],nodes=NODES,apis=APIS,edges=EDGES,paths=PATHS,requirements=[dict(id=f'R{i:02}',ref='requirements.md') for i in range(1,16)],gapKinds={'contract':'缺合同 / 接口','implementation':'实现落点待补','evidence':'证据待核实','decision':'需产品决定'})
