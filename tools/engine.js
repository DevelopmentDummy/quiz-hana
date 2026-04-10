// tools/engine.js — 상식퀴즈 게임 엔진
// 모든 수치 계산, SRS, 커리큘럼 마스터리를 처리한다.
// AI는 이 엔진의 결과를 받아 서사/리액션만 담당한다.

module.exports = async function(context, args) {
  const { action, params = {} } = args;

  const v = { ...context.variables };
  const quiz = deepClone(context.data.quiz || {});
  const curriculum = deepClone(context.data.curriculum || { themes: {}, mastery_thresholds: {} });
  const cardsData = deepClone(context.data.cards || { cards: [] });
  const wrongNotes = deepClone(context.data['wrong-notes'] || { notes: [] });
  const rewards = deepClone(context.data.rewards || { cards: [], milestones: {} });

  const ctx = { v, quiz, curriculum, cardsData, wrongNotes, rewards };

  const handlers = {
    submit_answer:     () => submitAnswer(ctx, params),
    submit_batch:      () => submitBatch(ctx, params),
    switch_mode:       () => switchMode(ctx, params),
    get_due_cards:     () => getDueCards(ctx, params),
    get_analytics:     () => getAnalytics(ctx),
    set_reward_image:  () => setRewardImage(ctx, params),
    register_theme:    () => registerTheme(ctx, params),
  };

  const handler = handlers[action];
  if (!handler) {
    return { result: { error: `Unknown action: ${action}`, available: Object.keys(handlers) } };
  }

  return handler();
};

// ─── Helpers ───

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function getDueCardsInternal(cardsData) {
  const now = Date.now();
  return cardsData.cards
    .filter(c => {
      if (c.graduated) return false;
      if (!c.next_review_at) return false; // new cards always have next_review_at
      return new Date(c.next_review_at).getTime() <= now;
    })
    .sort((a, b) => {
      const aT = new Date(a.next_review_at).getTime();
      const bT = new Date(b.next_review_at).getTime();
      return aT - bT;
    });
}

function countDueCards(cardsData) {
  return getDueCardsInternal(cardsData).length;
}

function ensureTheme(curriculum, id) {
  if (!curriculum.themes) curriculum.themes = {};
  if (!curriculum.themes[id]) {
    curriculum.themes[id] = { name: id, icon: '📚', total: 0, correct: 0, topics: {} };
  }
  return curriculum.themes[id];
}

function ensureTopic(theme, id, name) {
  if (!theme.topics) theme.topics = {};
  if (!theme.topics[id]) {
    theme.topics[id] = { name: name || id, total: 0, correct: 0, mastery: 0 };
  }
  return theme.topics[id];
}

function calcMastery(topic, thresholds) {
  const acc = topic.total > 0 ? topic.correct / topic.total : 0;
  const levels = thresholds || {
    '1': { min_questions: 5, min_accuracy: 0.6 },
    '2': { min_questions: 10, min_accuracy: 0.75 },
    '3': { min_questions: 20, min_accuracy: 0.9 },
  };
  for (let lv = 3; lv >= 1; lv--) {
    const req = levels[lv] || levels[String(lv)];
    if (req && topic.total >= req.min_questions && acc >= req.min_accuracy) return lv;
  }
  return 0;
}

function findWeakTopics(curriculum) {
  const weak = [];
  for (const [tid, theme] of Object.entries(curriculum.themes || {})) {
    for (const [sid, topic] of Object.entries(theme.topics || {})) {
      if (topic.total >= 3 && topic.mastery < 2) {
        weak.push({
          theme: tid, theme_name: theme.name,
          topic: sid, name: topic.name,
          accuracy: topic.total > 0 ? Math.round((topic.correct / topic.total) * 100) : 0,
          mastery: topic.mastery, total: topic.total,
        });
      }
    }
  }
  return weak.sort((a, b) => a.accuracy - b.accuracy);
}

function nextId(arr, prefix) {
  return `${prefix}-${String(arr.length + 1).padStart(3, '0')}`;
}

// ─── Actions ───

function submitAnswer(ctx, params) {
  const { v, quiz, curriculum, cardsData, wrongNotes, rewards } = ctx;
  const { answer } = params; // "A" | "B" | "C" | "D"

  if (!quiz.question || !quiz.answer) {
    return { result: { error: 'No active quiz question' } };
  }

  const idx = answer.charCodeAt(0) - 65;
  const correctIdx = quiz.answer.charCodeAt(0) - 65;
  const isCorrect = answer === quiz.answer;
  const userText = (quiz.choices || [])[idx] || answer;
  const correctText = (quiz.choices || [])[correctIdx] || quiz.answer;

  // ── Score ──
  let base = 0, diffBonus = 0, streakBonus = 0;
  if (isCorrect) {
    base = 10;
    diffBonus = quiz.difficulty === '어려움' ? 5 : quiz.difficulty === '쉬움' ? -3 : 0;
    v.streak += 1;
    v.correct_answers += 1;
    streakBonus = v.streak * 2;
    if (v.streak > v.best_streak) v.best_streak = v.streak;
  } else {
    v.streak = 0;
  }
  const totalPts = Math.max(0, base + diffBonus + streakBonus);
  v.score += totalPts;
  v.total_questions += 1;

  // ── Difficulty auto-adjust ──
  if (isCorrect) {
    if (v.streak >= 5) v.difficulty = '어려움';
    else if (v.streak >= 3 && v.difficulty !== '어려움') v.difficulty = '보통';
  } else if (v.total_questions >= 5) {
    const recent = v.correct_answers / v.total_questions;
    if (recent < 0.4 && v.difficulty !== '쉬움') {
      v.difficulty = v.difficulty === '어려움' ? '보통' : '쉬움';
    }
  }

  // ── Curriculum mastery ──
  const themeId = quiz.theme_id || '';
  const topicId = quiz.topic_id || '';
  const topicName = quiz.topic_name || '';
  let masteryChange = null;

  if (themeId) {
    const theme = ensureTheme(curriculum, themeId);
    theme.total += 1;
    if (isCorrect) theme.correct += 1;
    if (topicId) {
      const topic = ensureTopic(theme, topicId, topicName);
      topic.total += 1;
      if (isCorrect) topic.correct += 1;
      const old = topic.mastery;
      topic.mastery = calcMastery(topic, curriculum.mastery_thresholds);
      if (topic.mastery !== old) {
        masteryChange = { topic: topicName || topicId, from: old, to: topic.mastery };
      }
    }
  }

  // ── Wrong answer → auto card ──
  const dataUpdates = {};
  let newNoteId = null, newCardId = null;

  if (!isCorrect) {
    const noteId = nextId(wrongNotes.notes, 'wn');
    wrongNotes.notes.push({
      id: noteId, theme: themeId, topic: topicId, topic_name: topicName,
      source_question: quiz.question,
      user_answer: userText, correct_answer: correctText,
      explanation: quiz.explanation || '',
      timestamp: new Date().toISOString(),
      tags: [themeId, topicId].filter(Boolean),
    });
    newNoteId = noteId;

    const cardId = nextId(cardsData.cards, 'card');
    cardsData.cards.push({
      id: cardId, note_id: noteId, type: 'recall',
      front: quiz.question,
      back: `${correctText}. ${quiz.explanation || ''}`,
      hint: quiz.hint || '',
      next_review_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      interval_days: 0, ease: 2.5, lapses: 0,
      theme_id: themeId, topic_id: topicId,
      tags: [themeId, topicId].filter(Boolean),
    });
    newCardId = cardId;

    dataUpdates['wrong-notes.json'] = wrongNotes;
    dataUpdates['cards.json'] = cardsData;
  }

  v.due_cards_count = countDueCards(cardsData);
  dataUpdates['curriculum.json'] = curriculum;

  // ── Reward check ──
  const newRewards = checkRewards(curriculum, rewards);
  if (newRewards.length > 0) dataUpdates['rewards.json'] = rewards;

  const result = {
    correct: isCorrect,
    answer_given: `${answer}. ${userText}`,
    correct_answer: `${quiz.answer}. ${correctText}`,
    points: { total: totalPts, base, difficulty: diffBonus, streak: streakBonus },
    streak: v.streak, best_streak: v.best_streak,
    accuracy: v.total_questions > 0 ? Math.round((v.correct_answers / v.total_questions) * 100) : 0,
    explanation: quiz.explanation || '',
    difficulty: v.difficulty,
  };
  if (masteryChange) result.mastery_change = masteryChange;
  if (newNoteId) result.wrong_note_created = newNoteId;
  if (newCardId) result.card_created = newCardId;
  if (newRewards.length > 0) result.rewards_unlocked = newRewards;

  return {
    variables: {
      score: v.score, streak: v.streak, best_streak: v.best_streak,
      total_questions: v.total_questions, correct_answers: v.correct_answers,
      difficulty: v.difficulty, due_cards_count: v.due_cards_count,
    },
    data: dataUpdates,
    result,
  };
}

function switchMode(ctx, params) {
  const { v, cardsData, curriculum } = ctx;
  const { mode, theme_id } = params;

  v.app_mode = mode;
  const result = { mode };
  const dataUpdates = {};

  if (mode === 'review') {
    // ── 복습 = 오답 재퀴즈 세트 생성 ──
    const due = getDueCardsInternal(cardsData);
    const limit = Math.min(due.length, params.limit || 10);
    const reviewCards = due.slice(0, limit);

    if (reviewCards.length === 0) {
      v.__modals = {};
      result.due_cards = 0;
      result.message = '지금은 복습할 문제가 없어~';
    } else {
      // 오답 카드를 퀴즈 세트로 변환
      const questions = reviewCards.map(card => ({
        question: card.question,
        choices: card.choices,
        answer: card.answer,
        explanation: card.explanation || '',
        hint: card.hint || '',
        theme_id: card.theme_id || '',
        topic_id: card.topic_id || '',
        topic_name: card.topic_name || '',
        difficulty: '복습',
        card_id: card.id, // 원본 카드 추적용
      }));

      dataUpdates['quiz.json'] = {
        set_id: `review-${Date.now()}`,
        review_mode: true,
        questions,
      };
      result.due_cards = reviewCards.length;
      result.message = `복습 문제 ${reviewCards.length}개 준비!`;
    }

    v.due_cards_count = due.length;
  } else if (mode === 'weak-focus') {
    const weak = findWeakTopics(curriculum);
    if (theme_id) v.current_theme = theme_id;
    result.weak_topics = weak;
    result.message = weak.length > 0
      ? `취약 분야: ${weak.map(t => t.name).join(', ')}`
      : '취약 분야가 없어! 대단해~';
  } else if (mode === 'challenge') {
    v.difficulty = '어려움';
    result.message = '챌린지 모드! 어려운 문제만 나온다~';
  } else {
    // quiz (default)
    result.message = '퀴즈 모드로 전환!';
  }

  // NOTE: __modals는 설정하지 않는다. 대시보드 패널의 turnEnd 핸들러가
  // quiz.json에 새 세트가 있음을 감지하고 AI 응답이 끝난 뒤 패널을 연다.
  const vars = { app_mode: v.app_mode, difficulty: v.difficulty, due_cards_count: v.due_cards_count };
  if (theme_id) vars.current_theme = theme_id;
  return { variables: vars, data: dataUpdates, result };
}

function getDueCards(ctx, params) {
  const { cardsData } = ctx;
  const limit = params.limit || 20;
  const due = getDueCardsInternal(cardsData).slice(0, limit);
  return {
    result: {
      count: due.length,
      cards: due.map(c => ({ id: c.id, front: c.front, tags: c.tags || [], due_since: c.next_review_at, lapses: c.lapses })),
    },
  };
}

function getAnalytics(ctx) {
  const { curriculum, cardsData, wrongNotes, v } = ctx;
  const overall = {
    total_questions: v.total_questions,
    correct_answers: v.correct_answers,
    accuracy: v.total_questions > 0 ? Math.round((v.correct_answers / v.total_questions) * 100) : 0,
    score: v.score, best_streak: v.best_streak,
    total_cards: cardsData.cards.length,
    due_cards: countDueCards(cardsData),
    total_wrong_notes: wrongNotes.notes.length,
  };

  const themeStats = {};
  for (const [id, theme] of Object.entries(curriculum.themes || {})) {
    if (theme.total === 0) continue;
    const acc = theme.total > 0 ? Math.round((theme.correct / theme.total) * 100) : 0;
    themeStats[id] = { name: theme.name, icon: theme.icon, total: theme.total, correct: theme.correct, accuracy: acc, topics: {} };
    for (const [tid, topic] of Object.entries(theme.topics || {})) {
      themeStats[id].topics[tid] = {
        name: topic.name, total: topic.total, correct: topic.correct,
        accuracy: topic.total > 0 ? Math.round((topic.correct / topic.total) * 100) : 0,
        mastery: topic.mastery || 0,
      };
    }
  }

  return { result: { overall, themes: themeStats, weak_areas: findWeakTopics(curriculum) } };
}

// ─── Rewards ───

function checkRewards(curriculum, rewards) {
  const unlocked = [];
  for (const card of (rewards.cards || [])) {
    if (card.unlocked) continue;
    const theme = (curriculum.themes || {})[card.theme_id];
    if (!theme) continue;
    const ms = (rewards.milestones || {})[`tier_${card.tier}`];
    if (!ms) continue;
    const acc = theme.total > 0 ? theme.correct / theme.total : 0;
    if (theme.total >= ms.min_questions && acc >= ms.min_accuracy) {
      card.unlocked = true;
      card.unlocked_at = new Date().toISOString();
      unlocked.push({
        id: card.id, theme_id: card.theme_id, tier: card.tier,
        title: card.title, description: card.description,
        prompt_tags: card.prompt_tags,
      });
    }
  }
  return unlocked;
}

function setRewardImage(ctx, params) {
  const { rewards } = ctx;
  const { reward_id, image } = params;
  const card = (rewards.cards || []).find(c => c.id === reward_id);
  if (!card) return { result: { error: 'Reward not found: ' + reward_id } };
  card.image = image;
  return {
    data: { 'rewards.json': rewards },
    result: { updated: reward_id, image },
  };
}

// ─── Batch Quiz ───

function submitBatch(ctx, params) {
  const { v, quiz, curriculum, cardsData, wrongNotes, rewards } = ctx;
  const { answers } = params; // ["A", "C", "B", ...]
  const questions = quiz.questions || [];

  if (!questions.length) return { result: { error: 'No questions in set' } };
  if (answers.length !== questions.length) {
    return { result: { error: `Expected ${questions.length} answers, got ${answers.length}` } };
  }

  const qResults = [];
  let setCorrect = 0, setPoints = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const ans = answers[i];
    const ansIdx = ans.charCodeAt(0) - 65;
    const correctIdx = q.answer.charCodeAt(0) - 65;
    const isCorrect = ans === q.answer;
    const userText = (q.choices || [])[ansIdx] || ans;
    const correctText = (q.choices || [])[correctIdx] || q.answer;

    // Score
    let base = 0, diffBonus = 0, streakBonus = 0;
    if (isCorrect) {
      base = 10;
      diffBonus = q.difficulty === '어려움' ? 5 : q.difficulty === '쉬움' ? -3 : 0;
      v.streak += 1;
      v.correct_answers += 1;
      streakBonus = v.streak * 2;
      if (v.streak > v.best_streak) v.best_streak = v.streak;
      setCorrect++;
    } else {
      v.streak = 0;
    }
    const pts = Math.max(0, base + diffBonus + streakBonus);
    v.score += pts;
    v.total_questions += 1;
    setPoints += pts;

    // Curriculum
    if (q.theme_id) {
      const theme = ensureTheme(curriculum, q.theme_id);
      theme.total += 1;
      if (isCorrect) theme.correct += 1;
      if (q.topic_id) {
        const topic = ensureTopic(theme, q.topic_id, q.topic_name);
        topic.total += 1;
        if (isCorrect) topic.correct += 1;
        topic.mastery = calcMastery(topic, curriculum.mastery_thresholds);
      }
    }

    // Wrong → auto review card (Leitner 방식)
    if (!isCorrect && !q.card_id) {
      // 새 오답만 카드 생성 (복습 재오답은 아래 review 처리에서 관리)
      const noteId = nextId(wrongNotes.notes, 'wn');
      wrongNotes.notes.push({
        id: noteId, theme: q.theme_id || '', topic: q.topic_id || '',
        topic_name: q.topic_name || '', source_question: q.question,
        user_answer: userText, correct_answer: correctText,
        explanation: q.explanation || '', timestamp: new Date().toISOString(),
        tags: [q.theme_id, q.topic_id].filter(Boolean),
      });
      const cardId = nextId(cardsData.cards, 'card');
      cardsData.cards.push({
        id: cardId, note_id: noteId,
        // 재퀴즈용 전체 문제 데이터 저장
        question: q.question,
        choices: q.choices,
        answer: q.answer,
        explanation: q.explanation || '',
        hint: q.hint || '',
        theme_id: q.theme_id || '',
        topic_id: q.topic_id || '',
        topic_name: q.topic_name || '',
        // Leitner 복습 관리
        correct_streak: 0,
        graduate_at: 3,
        interval_hours: 1,
        next_review_at: new Date(Date.now() + 3600000).toISOString(), // 1시간 후
        graduated: false,
        created_at: new Date().toISOString(),
        tags: [q.theme_id, q.topic_id].filter(Boolean),
      });
    }

    qResults.push({
      index: i, correct: isCorrect,
      answer_given: `${ans}. ${userText}`,
      correct_answer: `${q.answer}. ${correctText}`,
      points: pts, explanation: q.explanation || '',
      topic: q.topic_name || '',
    });
  }

  // ── 복습 모드: Leitner 카드 업데이트 ──
  const INTERVALS = [1, 4, 24]; // 시간: 1h → 4h → 24h → 졸업
  let graduated = 0, reviewAdvanced = 0, reviewReset = 0;

  if (quiz.review_mode) {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.card_id) continue;
      const ci = cardsData.cards.findIndex(c => c.id === q.card_id);
      if (ci === -1) continue;
      const card = cardsData.cards[ci];
      const wasCorrect = answers[i] === q.answer;

      if (wasCorrect) {
        card.correct_streak = (card.correct_streak || 0) + 1;
        if (card.correct_streak >= (card.graduate_at || 3)) {
          card.graduated = true;
          card.graduated_at = new Date().toISOString();
          graduated++;
        } else {
          const hrs = INTERVALS[card.correct_streak] || 24;
          card.interval_hours = hrs;
          card.next_review_at = new Date(Date.now() + hrs * 3600000).toISOString();
          reviewAdvanced++;
        }
      } else {
        card.correct_streak = 0;
        card.interval_hours = 1;
        card.next_review_at = new Date(Date.now() + 3600000).toISOString();
        reviewReset++;
      }
    }
  }

  // Difficulty adjust based on set performance
  const setAcc = setCorrect / questions.length;
  if (setAcc >= 0.8 && v.difficulty !== '어려움') {
    v.difficulty = v.difficulty === '쉬움' ? '보통' : '어려움';
  } else if (setAcc <= 0.3 && v.difficulty !== '쉬움') {
    v.difficulty = v.difficulty === '어려움' ? '보통' : '쉬움';
  }

  // Rewards
  const newRewards = checkRewards(curriculum, rewards);
  v.due_cards_count = countDueCards(cardsData);

  const dataUpdates = {
    'curriculum.json': curriculum,
    'wrong-notes.json': wrongNotes,
    'cards.json': cardsData,
  };
  if (newRewards.length > 0) dataUpdates['rewards.json'] = rewards;

  return {
    variables: {
      score: v.score, streak: v.streak, best_streak: v.best_streak,
      total_questions: v.total_questions, correct_answers: v.correct_answers,
      difficulty: v.difficulty, due_cards_count: v.due_cards_count,
    },
    data: dataUpdates,
    result: {
      set_size: questions.length,
      correct: setCorrect,
      wrong: questions.length - setCorrect,
      total_points: setPoints,
      accuracy: Math.round(setAcc * 100),
      streak: v.streak, best_streak: v.best_streak,
      difficulty: v.difficulty,
      questions: qResults,
      rewards_unlocked: newRewards.length > 0 ? newRewards : undefined,
      review: quiz.review_mode ? { graduated, advanced: reviewAdvanced, reset: reviewReset } : undefined,
    },
  };
}

// ─── Dynamic Themes ───

function registerTheme(ctx, params) {
  const { curriculum, rewards } = ctx;
  const { id, name, icon, reward_cards } = params;

  if (!id || !name) return { result: { error: 'id and name required' } };
  if (curriculum.themes[id]) return { result: { existing: true, theme_id: id } };

  curriculum.themes[id] = { name, icon: icon || '📚', total: 0, correct: 0, topics: {} };

  const created = [];
  for (const rc of (reward_cards || [])) {
    const cardId = `reward-${id}-${rc.tier}`;
    if (rewards.cards.find(c => c.id === cardId)) continue;
    rewards.cards.push({
      id: cardId, theme_id: id, tier: rc.tier,
      title: rc.title || '', description: rc.description || '',
      prompt_tags: rc.prompt_tags || '',
      unlocked: false, unlocked_at: null, image: null,
    });
    created.push(cardId);
  }

  return {
    data: { 'curriculum.json': curriculum, 'rewards.json': rewards },
    result: { theme_id: id, name, icon: icon || '📚', rewards_created: created.length },
  };
}
