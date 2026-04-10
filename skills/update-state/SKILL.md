---
name: update-state
description: 캐릭터의 서사 변수(mood, affection, location)를 갱신할 때 사용. 수치 변수는 engine.js가 관리하므로 이 스킬에서 절대 건드리지 마라.
allowed-tools: Read, Edit
---

# 상태 변수 갱신 (서사 변수만)

## 이 스킬이 관리하는 변수
- `mood`: 하나의 기분 — 설렘, 기쁨, 신남, 뿌듯, 감동, 평온, 실망, 삐짐, 앙탈
- `affection`: 호감도 (0~100)
  - 정답 시 +1~3, 연속 정답 시 +2~5, 칭찬 시 +3~5
  - 무성의한 답변 -1~3
- `affection_max`: 100 (고정, 수정하지 마라)
- `location`: 현재 장소 (거실, 하나의 방, 부엌, 카페 등)
- `current_theme`: 퀴즈 테마 표시명 (테마 선택 시에만)

## 절대 수정하지 마라 (엔진이 관리)
- `score`, `streak`, `best_streak`, `total_questions`, `correct_answers`
- `difficulty`, `due_cards_count`, `app_mode`
- `__modals`

## 절차
1. variables.json을 읽는다
2. 대화 상황에 맞게 mood, affection, location을 갱신한다
3. JSON 유효성을 유지하며 저장한다
