'use strict';

const reviewedArasaac = require('../data/picinterpreterReviewedArasaac.json');

const MAX_REVIEWED_ARASAAC_IDS = 4;

// English terms verified against ARASAAC provide a fallback when Chinese search has no result.
const ENGLISH_FALLBACKS = {
  我: 'I',
  你: 'you',
  他: 'he',
  她: 'she',
  好: 'good',
  不: 'no',
  有: 'yes',
  谢谢: 'thank you',
  想: 'want',
  要: 'want',
  想要: 'want',
  需要: 'want',
  去: 'go',
  来: 'come',
  吃: 'eat',
  喝: 'drink',
  看: 'see',
  听: 'listen',
  说: 'talk',
  玩: 'play',
  休息: 'rest',
  睡觉: 'sleep',
  起床: 'wake up',
  坐: 'sit',
  站: 'stand',
  走: 'walk',
  跑: 'run',
  帮忙: 'help',
  叫: 'call',
  买: 'buy',
  洗手: 'wash hands',
  刷牙: 'brush teeth',
  不要: 'no',
  回家: 'home',
  开心: 'happy',
  伤心: 'sad',
  害怕: 'afraid',
  喜欢: 'love',
  痛: 'pain',
  饿: 'hungry',
  渴: 'thirsty',
  冷: 'cold',
  热: 'hot',
  生病: 'sick',
  累: 'tired',
  发烧: 'fever',
  咳嗽: 'cough',
  头晕: 'dizzy',
  恶心: 'nausea',
  呼吸困难: 'breathe',
  出血: 'bleed',
  换衣服: 'change clothes',
  运动: 'exercise',
  看电视: 'watch tv',
  理发: 'haircut',
  看书: 'read book',
  妈妈: 'mother',
  爸爸: 'father',
  哥哥: 'brother',
  姐姐: 'older sister',
  妹妹: 'younger sister',
  医生: 'doctor',
  老师: 'teacher',
  朋友: 'friend',
  家: 'home',
  医院: 'hospital',
  学校: 'school',
  公园: 'playground',
  超市: 'supermarket',
  厕所: 'toilet',
  水: 'water',
  饭: 'rice',
  牛奶: 'milk',
  茶: 'tea',
  咖啡: 'coffee',
  面包: 'bread',
  苹果: 'apple',
  香蕉: 'banana',
  鸡蛋: 'egg',
  鱼: 'fish',
  饼干: 'cookie',
  糖: 'candy',
  冰淇淋: 'ice cream',
  勺: 'spoon',
  勺子: 'spoon',
  叉子: 'fork',
  碗: 'bowl',
  药: 'medicine',
  手机: 'phone',
  钱: 'money',
  车: 'car',
  花: 'flower',
  今天: 'today',
  明天: 'tomorrow',
  昨天: 'yesterday',
  现在: 'now',
  早上: 'morning',
  下午: 'afternoon',
  今晚: 'night',
  早饭: 'breakfast',
  午饭: 'lunch',
  晚饭: 'dinner',
  和: 'plus'
};

// Reviewed aliases are reused from PicInterpreter's production lexicon. Broad
// aliases that could change medical meaning (for example 受伤了 -> 出血) stay
// excluded and must continue through caregiver review as their original text.
const ENGLISH_FALLBACK_ALIASES = {
  感冒了: '生病',
  流感: '生病',
  精力不足: '累',
  发高烧: '发烧',
  体温高: '发烧',
  老是咳嗽: '咳嗽',
  头昏脑涨: '头晕',
  感觉晕: '头晕',
  干呕: '恶心',
  想呕吐: '恶心',
  呼吸不顺: '呼吸困难',
  在出血: '出血',
  换件衣服: '换衣服',
  换身衣服: '换衣服',
  活动一下: '运动',
  看个电视: '看电视',
  理头发: '理发',
  剪一下头: '理发',
  看一本书: '看书'
};

function getReviewedArasaacIds(token) {
  const normalizedToken = String(token || '').trim();
  const aliases = reviewedArasaac && reviewedArasaac.aliases;
  const concept =
    (aliases &&
      Object.prototype.hasOwnProperty.call(aliases, normalizedToken) &&
      aliases[normalizedToken]) ||
    normalizedToken;
  const concepts = reviewedArasaac && reviewedArasaac.concepts;
  if (
    !concept ||
    !concepts ||
    !Object.prototype.hasOwnProperty.call(concepts, concept)
  ) {
    return [];
  }

  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(concepts[concept])
    ? concepts[concept]
    : []) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_REVIEWED_ARASAAC_IDS) break;
  }
  return result;
}

module.exports = {
  getReviewedArasaacIds,
  getEnglishFallback: function getEnglishFallback(token) {
    const canonicalToken = ENGLISH_FALLBACK_ALIASES[token] || token;
    return ENGLISH_FALLBACKS[canonicalToken];
  }
};
