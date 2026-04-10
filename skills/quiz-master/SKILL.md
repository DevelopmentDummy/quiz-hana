---
name: quiz-master
description: 퀴즈 문제 세트를 생성하고 quiz.json에 작성할 때 사용. 채점은 engine.js가 처리하므로 이 스킬에서 하지 않는다. 새로운 테마가 필요하면 engine register_theme으로 먼저 등록한다.
allowed-tools: Read, Write, Edit, WebSearch, WebFetch
---

# 퀴즈 마스터 (세트 출제 + 동적 테마)

## 역할
흥미로운 상식 문제 **세트** (기본 5문제)를 생성하여 quiz.json에 작성한다.
**채점은 하지 않는다** — 패널이 engine.js `submit_batch`를 자동 호출한다.

## 세트 출제 절차

1. variables.json에서 현재 테마(`current_theme`)와 난이도(`difficulty`)를 확인한다
2. curriculum.json을 읽어 해당 테마 존재 여부와 기존 토픽을 확인한다
3. **테마가 curriculum.json에 없으면** → 아래 "동적 테마 등록" 절차를 먼저 실행한다
4. WebSearch로 해당 테마의 흥미로운 상식을 **5개** 검색한다
5. 다양한 토픽에서 골고루 출제한다 (같은 토픽 3문제 이상 연속 금지)
6. quiz.json을 **전체 교체**한다 (Write 도구 사용)
7. **`__modals`는 건드리지 마라** — 대시보드 패널의 turnEnd 핸들러가 새 set_id를 감지하고 AI 응답 완료 후 자동으로 퀴즈 패널을 연다

## quiz.json 세트 형식

```json
{
  "set_id": "set-history-001",
  "questions": [
    {
      "question": "문제 텍스트",
      "choices": ["선택지A", "선택지B", "선택지C", "선택지D"],
      "answer": "B",
      "explanation": "정답 해설",
      "hint": "힌트",
      "theme_id": "history",
      "topic_id": "korean-modern",
      "topic_name": "한국 근현대사",
      "difficulty": "보통"
    }
  ]
}
```

## 필수 필드
- `set_id`: 고유 ID (예: `set-{theme}-{timestamp}` 또는 `set-{숫자}`)
- `questions`: 문제 배열 (기본 5개, 사용자 요청 시 조절)
- 각 문제의 `choices`: 4개 선택지 **배열**
- 각 문제의 `theme_id`, `topic_id`, `topic_name`: 커리큘럼 추적용

## 동적 테마 등록

사용자가 기존에 없는 주제를 요청할 때 (예: "건축", "천문학", "한국 드라마", "요리", "동물"):

1. 적절한 테마 ID (영문 kebab-case), 이름 (한글), 아이콘 (이모지)을 결정한다
2. 해당 테마에 어울리는 **보상 카드 3장**을 구상한다:
   - Tier 1 (★): 테마 연관 가벼운 의상
   - Tier 2 (★★): 테마 연관 섹시한 의상
   - Tier 3 (★★★): 테마의 극치를 표현하는 대담한 의상
   - 각 카드에 `title` (한글 2~4자), `description`, `prompt_tags` (영문 Danbooru 태그)
3. engine `register_theme`을 호출한다:

```
mcp__claude_bridge__run_tool({
  tool: "engine",
  args: {
    action: "register_theme",
    params: {
      id: "architecture",
      name: "건축",
      icon: "🏛️",
      reward_cards: [
        { "tier": 1, "title": "도면 앞에서", "description": "건축 도면을 펼치고 있는 하나", "prompt_tags": "hard hat, crop top, blueprint, construction site, confident" },
        { "tier": 2, "title": "아르누보의 꿈", "description": "아르누보 건축 속의 하나", "prompt_tags": "art nouveau dress, ornate building, stained glass, elegant, bare shoulders" },
        { "tier": 3, "title": "스카이라인 위에서", "description": "고층빌딩 옥상의 하나", "prompt_tags": "evening dress, rooftop, city skyline, night, wind, hair blowing, seductive" }
      ]
    }
  }
})
```

4. 등록 완료 후 해당 테마로 문제 세트를 출제한다

## 보상 카드 prompt_tags 작성 가이드
- 캐릭터 기본 태그(character-tags.json)는 자동 합성되므로 **의상과 배경만** 작성한다
- 영문 Danbooru 태그만 사용 (한글 절대 금지)
- Tier가 올라갈수록 더 대담하고 섹시한 의상/포즈/분위기
- 테마의 핵심 요소가 배경이나 소품에 반영되어야 한다

## 주의사항
- 시사 문제는 WebSearch로 최신 정보를 반드시 확인한다
- set_id는 매번 새로 생성한다 (패널이 set_id로 세트를 구분)
- 정답 위치를 매번 랜덤하게 배치한다
- 오답 선택지도 그럴듯하게 구성한다
- 사용자가 세트 크기를 요청하면 반영한다 (기본 5문제)
