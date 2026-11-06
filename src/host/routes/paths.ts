// routes/paths.mjs —— 路由路径常量。
//
// 集中一处：路由模块只引用常量，路径字符串不再散落在 index.js 与各路由文件里；
// 改路径时改这里，测试（tests/integration/routes.test.ts）按行为断言会自动发现。
//
// 说明：阶段 2 起前端全部并入 bundle（dist/client.js），由宿主按 package.json 的
// exports["./client"] 加载；原来那 6 条静态脚本路由（core/voice/wordcard*/annotate/client）
// 连同注入行一起删除，这里只剩数据面 API。

export const API_LOOKUP = '/dsh-word-learn/lookup'
export const API_SAVE = '/dsh-word-learn/save'
export const API_LIST = '/dsh-word-learn/list'
export const API_UPDATE = '/dsh-word-learn/update'
export const API_REMOVE = '/dsh-word-learn/remove'
export const API_DASHBOARD = '/dsh-word-learn/dashboard'
export const API_QUEUE = '/dsh-word-learn/queue'
export const API_GRADE = '/dsh-word-learn/grade'
export const API_WORD = '/dsh-word-learn/word'
export const API_TRANSLATE = '/dsh-word-learn/translate'
export const API_ENRICH_AI = '/dsh-word-learn/enrich-ai'
export const API_QUIZ = '/dsh-word-learn/quiz'
export const API_REPAIR = '/dsh-word-learn/repair'
export const API_REPAIR_LOG = '/dsh-word-learn/repair/log'
export const API_REPAIR_CLEAR = '/dsh-word-learn/repair/clear'
export const API_REPAIR_STATS = '/dsh-word-learn/repair/stats'
export const API_RECAP = '/dsh-word-learn/repair/recap'
export const API_SENSE_MAP = '/dsh-word-learn/sense-map'
export const API_ANNOTATE_WORDS = '/dsh-word-learn/annotate/words'
export const API_MODEL_INFO = '/dsh-word-learn/model-info'
export const API_MODELS = '/dsh-word-learn/models'
export const API_MODEL = '/dsh-word-learn/model'
