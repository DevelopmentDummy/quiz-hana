---
name: update-panels
description: 패널 HTML 구조를 수정해야 할 때 사용
allowed-tools: Read, Write, Edit, Glob
---

# 패널 수정

/frontend-design 스킬을 사용하여 패널을 수정하라.
panel-spec.md를 먼저 읽어라.

## 패널 목록
- `01-dashboard.html` (right): 학습 대시보드 — 점수, 스트릭, 정답률, 모드, 테마별 현황, 하나 상태, 복습 대기
- `02-quiz.html` (modal): 퀴즈 + 복습 공용 패널 — quiz.json의 questions 배열을 세트로 표시, 배치 채점 후 이벤트 큐. 복습 모드일 때도 같은 패널 사용 (오답 재퀴즈)
- `04-curriculum.html` (modal): 커리큘럼 트리 — curriculum.json 테마/토픽/마스터리 표시

## 데이터 접근
- variables.json: `{{변수명}}` (score, streak 등)
- quiz.json: `{{quiz.questions}}`, `{{quiz.set_id}}`, `{{quiz.review_mode}}` 등
- curriculum.json: `{{curriculum.themes}}` 등
- rewards.json: `{{rewards.cards}}` 등

## 규칙
- Shadow DOM 안에서 렌더링됨
- 인라인 이벤트 핸들러 사용 금지 (data-* + addEventListener)
- 테마: 핑크-보라 (accent: #ff6b9d, bg: #1a1028, surface: #251a35)
- 패널 인터랙션은 `__panelBridge.runTool('engine', ...)` 패턴 사용
