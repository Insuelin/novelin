export const KINDS = {
  rule: '规则',
  location: '地点',
  character: '人物',
  item: '物品',
  outline: '大纲',
};

const SUFFIX_RE = /(做法|教程|指南|配方|资料|说明|笔记|大全|流程|步骤|方法|设定|规则|地图)$/;
const GENERIC = new Set(['做法', '教程', '指南', '配方', '资料', '说明', '笔记', '大全', '流程', '步骤', '方法', '设定', '规则', '地图', '内容', '注意事项']);

export function createMaterials() {
  return [
    {
      id: 'fruit-tea',
      title: '果茶做法',
      kind: 'rule',
      summary: '茶底、水果搭配、糖浆比例和冷藏时间。',
      content: [
        '茶底：茉莉绿茶 6g，85℃ 水 300ml，泡 3 分钟后滤掉茶叶。',
        '水果：柠檬两片、橙子两片、草莓三颗，轻压出汁，不要捣碎。',
        '糖浆：白砂糖和热水 1:1 化开，放凉后加 15ml。',
        '混合后加冰块，冷藏 10 分钟再喝。',
      ].join('\n'),
      triggers: ['果茶', '水果茶', '茶饮'],
      enabled: true,
    },
    {
      id: 'lighthouse',
      title: '雾港灯塔',
      kind: 'location',
      summary: '雾港北岸的废弃灯塔，是调查线的起点。',
      content: '灯塔停用多年，铁门生锈，塔顶的灯还能亮。旧码头在灯塔背面，退潮时露出一段石阶。',
      triggers: ['灯塔', '雾港', '旧码头'],
      enabled: true,
    },
    {
      id: 'sherry',
      title: '樱雪琳角色设定',
      kind: 'character',
      summary: '主角。行动力强，习惯先观察再开口。',
      content: '樱雪琳，朋友叫她雪琳。随身带一把折伞和一本写满批注的旧笔记。',
      triggers: ['樱雪琳', '雪琳'],
      enabled: true,
    },
    {
      id: 'letter',
      title: '母亲的信',
      kind: 'item',
      summary: '一封没有寄出的信，提到灯塔和旧码头。',
      content: '信纸泛黄，只有三行字：不要相信雾里的灯。去旧码头找阿澈。信末没有署名。',
      triggers: ['母亲的信', '那封信'],
      enabled: true,
    },
    {
      id: 'sea-fog',
      title: '海雾规则',
      kind: 'rule',
      summary: '雾起时灯塔会熄灭，雾散后恢复。',
      content: '海雾每天傍晚从港口进来，持续约两个小时。雾里能见度很低，钟声会晚三分钟。',
      triggers: ['海雾', '雾潮'],
      enabled: false,
    },
  ];
}

export function matchMaterials(text, materials) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack.trim()) return [];
  const hits = [];
  for (const material of materials) {
    if (!material.enabled) continue;
    const candidates = (material.triggers || [])
      .map((trigger) => String(trigger || '').trim())
      .filter(Boolean)
      .filter((trigger) => haystack.includes(trigger.toLowerCase()));
    if (!candidates.length) continue;
    candidates.sort((a, b) => b.length - a.length);
    hits.push({
      material,
      trigger: candidates[0],
      at: haystack.indexOf(candidates[0].toLowerCase()),
    });
  }
  return hits.sort((a, b) => a.at - b.at);
}

export function suggestTriggers(title) {
  const value = String(title || '').trim();
  if (!value) return [];
  const base = value.replace(SUFFIX_RE, '').trim();
  const pieces = [
    base,
    ...value.split(/[\s,，、/|:：()（）]+/),
  ];
  return [...new Set(pieces
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !GENERIC.has(item) && !SUFFIX_RE.test(item)))]
    .slice(0, 6);
}
