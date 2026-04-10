# Panel System Specification

패널 시스템의 기술 레퍼런스. 빌더와 RP 세션 양쪽에서 참조한다.

---

## 데이터 드리븐 설계 원칙

패널과 대화 엔진의 핵심 패러다임은 **데이터 드리븐**이다. 로직을 하드코딩하지 않고, 데이터 파일이 시스템의 행동을 결정하도록 설계한다.

### 상태의 단일 진실 원천 (Single Source of Truth)

모든 게임/서사 상태는 JSON 데이터 파일에 존재한다. 패널은 이 데이터를 **읽어서 표시**하고, 사용자 조작 시 이 데이터를 **갱신**한다. AI도 같은 데이터를 읽고 쓴다.

```
[JSON 데이터] ←→ [패널 UI] (표시 + 조작)
     ↕
  [AI 에이전트]  (읽기 + 갱신)
```

- `variables.json` — 매 턴 바뀌는 동적 상태 (HP, 위치, 시간 등)
- 커스텀 `*.json` — 구조화된 데이터 (인벤토리, NPC, 월드맵 등)
- 패널 HTML — 데이터의 **뷰(view)** 역할. 데이터가 바뀌면 자동 재렌더링
- 커스텀 툴 — 데이터의 **컨트롤러(controller)** 역할. 결정적 로직 처리

이 구조에서 패널은 절대 자체 상태를 갖지 않는다. 재렌더링되면 DOM이 초기화되므로, 유지해야 할 상태는 반드시 JSON 파일에 저장한다.

### AI와 패널의 역할 분리

| 역할 | 처리 주체 | 근거 |
|------|-----------|------|
| 서사, 감정, 대화 | AI | 비결정적, 문맥 의존적 |
| 상태 변이 로직 | 엔진 스크립트 (서버 JS) | 결정적, 재현 가능, 규칙 중앙 관리 |
| 상태 표시, 사용자 입력 | 패널 (Handlebars + JS) | 데이터 바인딩 |

AI가 직접 HP를 깎거나 인벤토리를 조작하는 것도 가능하지만, **규칙이 있는 로직**은 엔진에 위임하는 것이 일관성 있다. AI가 매 턴마다 모든 변수의 규칙을 기억하고 정확히 조작하기는 어렵다. 엔진에 규칙을 한 번 정의해두면 AI는 "무엇이 일어났는지"만 전달하고, 실제 수치 변경은 엔진이 처리한다.

### 엔진 중심 아키텍처

**핵심 아이디어:** 분산된 개별 변수 조작 대신, 하나의 **엔진 스크립트**(`tools/engine.js`)가 게임/서사 상태 변이의 허브 역할을 한다. AI와 패널 모두 엔진을 통해 상태를 변경한다.

```
AI 턴 종료 → MCP 툴로 엔진 호출 → 엔진이 규칙 적용 → 데이터 갱신 → 패널 자동 반영
패널 버튼 → runTool('engine', ...) → 엔진이 규칙 적용 → 데이터 갱신 → 패널 자동 반영
```

**엔진이 중앙에서 관리하면 좋은 것들:**
- 시간 경과에 따른 변화 (시간대, 날씨 전이, NPC 스케줄)
- 캐릭터 스탯 변동 (감정 감쇠, 체력 회복, 상태이상 턴 카운트)
- 인벤토리 조작 (소모품 사용, 획득, 내구도 감소)
- 위치/씬 전환 (이동 시 동반되는 부수 효과)
- 아웃핏/외형 변경 (장비 교체에 따른 스탯 반영)
- 조건부 이벤트 트리거 (특정 수치 임계점 도달 시 플래그 설정)

**엔진이 없으면 생기는 문제:**
- AI가 매 턴 "HP를 5 깎고, 시간을 1시간 진행시키고, 인벤토리에서 화살 1개 빼고..." 등을 직접 해야 함
- 규칙이 프롬프트에 흩어져 있어 놓치기 쉬움
- 같은 행동이라도 턴마다 다르게 처리될 수 있음

### 엔진 스크립트 설계 패턴

엔진은 **액션 타입**을 받아 해당하는 규칙을 적용하는 디스패처다:

```javascript
// tools/engine.js
const ACTIONS = {
  advance_time(ctx, args) {
    const { hours = 1 } = args;
    let h = ctx.variables.hour + hours;
    let day = ctx.variables.day;
    if (h >= 24) { h -= 24; day++; }

    const period =
      h < 6 ? '새벽' : h < 12 ? '오전' : h < 18 ? '오후' : '밤';

    return {
      variables: { hour: h, day, period },
    };
  },

  use_item(ctx, args) {
    const { item, quantity = 1 } = args;
    const inv = { ...ctx.data.inventory?.items };
    if ((inv[item] || 0) < quantity) {
      return { result: { success: false, message: `${item} 부족` } };
    }
    inv[item] -= quantity;
    if (inv[item] <= 0) delete inv[item];

    // 아이템별 효과 적용
    const effects = ctx.data.items?.effects?.[item] || {};
    const vars = {};
    for (const [stat, delta] of Object.entries(effects)) {
      const max = ctx.variables[`${stat}_max`] || Infinity;
      vars[stat] = Math.min(max, (ctx.variables[stat] || 0) + delta);
    }

    return {
      variables: vars,
      data: { "inventory.json": { items: inv } },
      result: { success: true, item, quantity, effects: vars },
    };
  },

  change_location(ctx, args) {
    const { destination } = args;
    // 이동 시 시간도 경과
    const travel = ctx.data.world?.travelTimes?.[destination] || 1;
    const timeResult = ACTIONS.advance_time(ctx, { hours: travel });

    return {
      variables: { ...timeResult.variables, location: destination },
      result: { success: true, destination, travelHours: travel },
    };
  },

  update_outfit(ctx, args) {
    const { outfit, description } = args;
    return {
      variables: { outfit, outfitDescription: description },
    };
  },
};

module.exports = async function(context, args) {
  const { action, ...params } = args;
  const handler = ACTIONS[action];
  if (!handler) {
    return { result: { success: false, message: `알 수 없는 액션: ${action}` } };
  }
  return handler(context, params);
};
```

### 엔진 호출 방법

**AI (MCP 툴) 에서:**
AI는 대화 응답을 쓴 후, MCP `update_variables` / `update_data` 대신 엔진을 호출한다. 세션의 CLAUDE.md에 이 패턴을 명시하면 된다:

```markdown
<!-- session-instructions.md 예시 -->
## 상태 관리 규칙
매 턴 종료 시, 변수를 직접 수정하지 말고 엔진 툴을 호출하여 상태를 갱신하라.
- 시간 경과: `run_tool("engine", { action: "advance_time", hours: N })`
- 아이템 사용: `run_tool("engine", { action: "use_item", item: "이름" })`
- 위치 이동: `run_tool("engine", { action: "change_location", destination: "장소" })`
```

**패널에서:**
```javascript
// 소모품 사용 버튼
const res = await __panelBridge.runTool('engine', {
  action: 'use_item',
  item: '회복포션'
});
// 엔진이 인벤토리 감소 + HP 증가를 한 번에 처리
// 패널이 자동 재렌더링됨

// AI에게 알림 (선택적)
if (res.result?.success) {
  const fx = Object.entries(res.result.effects || {})
    .map(([k,v]) => `${k} ${v > 0 ? '+' : ''}${v}`)
    .join(', ');
  await __panelBridge.queueEvent(`[아이템사용: ${res.result.item}×${res.result.quantity} → ${fx}]`);
}
```

### 엔진 설계 시 고려사항

- **액션은 독립적이되, 조합 가능하게.** `change_location` 안에서 `advance_time`을 호출하듯, 복합 효과를 액션 조합으로 구성한다.
- **아이템 효과 등 규칙은 데이터 파일에.** 엔진 코드에 "회복포션은 HP +50"을 하드코딩하지 말고, `items.json`의 `effects` 필드에서 읽는다. 새 아이템 추가 시 코드 수정이 필요 없다.
- **반환값의 `result`에 충분한 정보를.** 패널이 결과를 표시하거나, `queueEvent`로 AI에게 요약을 전달할 때 필요하다.
- **엔진은 판정만, 서사는 AI가.** 엔진이 "데미지 12, 크리티컬" 같은 결과를 내면, AI가 이를 "검이 빛을 내며 급소를 관통했다"로 풀어쓴다. 엔진에 서사 텍스트를 넣지 않는다.

### 엔진-패널 간 계약 (중요)

패널에서 엔진 결과를 참조할 때, **반드시 엔진 코드를 읽고 실제 반환 구조를 확인한 뒤** 필드를 참조하라. 추측하지 마라.

엔진의 `result` 구조가 flat인지 nested인지는 엔진마다 다르다:

```javascript
// flat 구조 — result.damage로 바로 접근
result: { success: true, damage: 12, crit: true }

// nested 구조 — result.economy.name으로 접근해야 함
result: { success: true, economy: { name: '회복포션', price: 50, newBalance: 450 } }
```

**흔한 실수:** 엔진이 `result.economy.name`을 반환하는데, 패널에서 `result.name`으로 접근하면 `undefined`가 된다. 이런 버그는 실행 전까지 드러나지 않는다.

**원칙:**
- 엔진의 반환 구조를 코드 상단 주석에 문서화하라 (액션별 result 필드)
- 패널을 작성하거나 수정할 때, 엔진의 해당 액션 코드를 먼저 읽어라
- `queueEvent` 헤더에 쓸 필드도 엔진 반환값에서 정확한 경로로 참조하라

### 패널 액션과 AI 인지의 연결

패널에서 사용자가 행동(아이템 사용, 이동 등)을 수행할 때, 데이터는 엔진을 통해 즉시 갱신되지만 **AI는 이를 모른다**. 다음 메시지에 맥락을 전달하려면 `queueEvent`를 사용한다:

```javascript
// 패널에서 소모품 사용
const res = await __panelBridge.runTool('engine', { action: 'use_item', item: '회복포션' });
// → 엔진이 HP +50, 포션 -1 등 데이터 즉시 반영

// AI에게 알려주기 위한 헤더 적재
await __panelBridge.queueEvent(`[아이템사용: 회복포션×1 → HP +50]`);
// → 사용자의 다음 메시지 앞에 이 헤더가 자동 첨부됨
```

AI가 받게 되는 메시지:
```
[아이템사용: 회복포션×1 → HP +50]
다음 방으로 이동하자
```

`queueEvent`는 누적된다. 여러 액션이 쌓이면 여러 줄의 헤더가 한꺼번에 전달된다. OOC 메시지에는 첨부되지 않는다.

**사용하지 않아도 되는 경우:**
- `sendMessage`로 직접 AI에게 메시지를 보내는 경우 (이미 AI가 인지함)
- AI가 직접 엔진을 호출한 경우 (자기가 요청한 일이므로 인지함)
- 순수 UI 조작 (탭 전환 등 서사에 영향 없는 행동)

### 데이터 구조 설계 팁

**인벤토리 — 객체 vs 배열:**
```jsonc
// 단순 수량 관리: 객체가 편리
{ "items": { "회복포션": 3, "해독제": 1 } }

// 개별 속성이 다른 장비: 배열이 적합
{ "equipment": [
  { "name": "철검", "atk": 15, "durability": 80 },
  { "name": "가죽갑옷", "def": 8, "durability": 100 }
]}
```

**아이템 효과 — 데이터로 정의:**
```jsonc
// items.json — 효과 정의 (엔진이 참조)
{
  "effects": {
    "회복포션": { "hp": 50 },
    "해독제": { "poison": -1 },
    "발정촉진제": { "arousal": 30, "sensitivity": 10 }
  }
}
```

**NPC/적 — 정적 정의 + 동적 상태 분리:**
```jsonc
// world.json — 월드 정의 (반정적)
{ "enemies": [
  { "name": "고블린", "maxHp": 30, "hp": 30, "atk": 5 }
]}

// variables.json — 현재 전투 상태 (동적)
{ "inCombat": true, "currentEnemy": "고블린" }
```

**핵심: 데이터 구조가 곧 게임 디자인이다.** 어떤 값을 추적할지, 어떤 관계를 모델링할지 결정하면 엔진과 패널은 그 데이터를 따라 자연스럽게 구성된다. 규칙까지 데이터에 넣으면(아이템 효과, 이동 소요 시간 등) 엔진 코드 수정 없이 콘텐츠만으로 시스템을 확장할 수 있다.

---

## 파일 네이밍 규약

패널 파일은 `panels/` 디렉토리에 위치하며, 다음 형식을 따른다:

```
{두자리숫자}-{이름}.html
```

- 숫자는 표시 순서를 결정한다 (예: `01-상태.html`, `02-프로필.html`, `03-인벤토리.html`)
- 사용자에게 표시될 때 숫자 prefix는 자동 제거된다 (`01-상태` → `상태`)
- prefix가 없는 파일명도 동작한다 (`status.html` → `status`)

---

## Handlebars 헬퍼 목록

패널은 Handlebars 템플릿이며, `variables.json`의 값이 `{{변수명}}`으로 자동 주입된다.

### 산술 헬퍼

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `percentage` | `{{percentage val max}}` | 백분율 계산 (val/max×100, 반올림) |
| `add` | `{{add a b}}` | 더하기 |
| `subtract` | `{{subtract a b}}` | 빼기 |
| `multiply` | `{{multiply a b}}` | 곱하기 |
| `divide` | `{{divide a b}}` | 나누기 (0 나누기 방지) |
| `formatNumber` | `{{formatNumber n}}` | 천 단위 쉼표 |

### 비교 헬퍼

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `eq` | `{{#if (eq a b)}}` | 같음 |
| `ne` | `{{#if (ne a b)}}` | 다름 |
| `lt` | `{{#if (lt a b)}}` | 미만 |
| `lte` | `{{#if (lte a b)}}` | 이하 |
| `gt` | `{{#if (gt a b)}}` | 초과 |
| `gte` | `{{#if (gte a b)}}` | 이상 |

### 논리 헬퍼

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `and` | `{{#if (and a b)}}` | 논리 AND |
| `or` | `{{#if (or a b)}}` | 논리 OR |
| `not` | `{{#if (not a)}}` | 논리 NOT |

### 조건문 예시

```handlebars
{{#if (gt hp 50)}}높음{{else}}낮음{{/if}}
{{#if (eq weather "맑음")}}☀️{{/if}}
{{#if (and (gt trust 50) (gt affection 30))}}친밀{{/if}}
```

---

## 렌더링 환경

- 각 패널은 **Shadow DOM** 안에서 렌더링된다 → 외부 스타일과 충돌 없음
- 패널 컨테이너 기본 스타일: `padding: 8px 12px`, `font-size: 13px`, `color: #e0e0e0`
- `<style>` 태그를 패널 상단에 포함시켜 스코프 CSS를 작성한다

---

## CSS 스타일 가이드

### 기본 원칙

- **다크 테마** 기반 (배경 `#1a1a2e` 계열, 텍스트 `#e0e0e0` 계열)
- 캐릭터에 맞는 **액센트 색상**을 선택한다
- 폰트 크기는 `11px`~`13px` 범위로 유지한다

### 게이지 바 패턴

```html
<div class="stat">
  <span class="label">호감</span>
  <div class="bar-bg">
    <div class="bar love" style="width:{{percentage affection affection_max}}%"></div>
  </div>
  <span class="val">{{affection}}/{{affection_max}}</span>
</div>
```

```css
.stat { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.label { width: 48px; color: #8888a0; flex-shrink: 0; }
.bar-bg { flex: 1; height: 8px; background: #1a1a2e; border-radius: 4px; overflow: hidden; }
.bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
.val { width: 48px; text-align: right; font-size: 11px; color: #8888a0; }
```

### 태그/뱃지 패턴

```html
<div class="tags">
  <span class="tag">📍 {{location}}</span>
  <span class="tag">🕐 {{time}}</span>
</div>
```

```css
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
.tag { background: #1a1a2e; padding: 2px 8px; border-radius: 4px; font-size: 11px; color: #8888a0; }
```

### 섹션 제목

```css
.section-title { font-size: 11px; color: #6c63ff; margin: 10px 0 6px; font-weight: 600; }
```

---

## variables.json 설계 규칙

- **게이지형 변수**는 반드시 `_max` 짝을 만든다: `hp` + `hp_max`, `affection` + `affection_max`
- 변수명은 **영문 snake_case**로 작성한다
- 위치(`location`), 시간(`time`), 날씨(`weather`) 같은 상황 변수를 포함한다
- **하드코딩 금지**: 패널에서 최댓값이나 문자열을 직접 쓰지 말고 반드시 변수로 참조한다
- 캐릭터 고유의 특수 변수를 추가한다 (예: 마법사 → `mana`, 탐정 → `clues_found`)

---

## 커스텀 데이터 파일

`variables.json` 외에 **임의의 `*.json` 파일**을 세션/페르소나 디렉토리에 두면 패널 템플릿에서 자동으로 접근할 수 있다. 파일명(확장자 제외)이 Handlebars 컨텍스트의 키가 된다.

### 예시

`world.json`:
```json
{
  "locations": [
    { "name": "크로엔 왕도", "distance": 5, "goods": "공예품, 보석", "desc": "거대한 성벽의 수도" },
    { "name": "리헨 평원시장", "distance": 7, "goods": "곡물, 가축", "desc": "드넓은 초원 위의 장터" },
    { "name": "벨라항", "distance": 3, "goods": "해산물, 향신료", "desc": "남쪽 항구 도시" }
  ],
  "routes": {
    "크로엔 왕도-벨라항": { "days": 4, "danger": "low" },
    "벨라항-리헨 평원시장": { "days": 6, "danger": "medium" }
  }
}
```

패널에서 사용:
```handlebars
{{#each world.locations}}
  {{#if (ne this.name ../location)}}
    <div class="dest">{{this.name}} — {{this.distance}}일 거리</div>
  {{/if}}
{{/each}}
```

`items.json`, `npcs.json`, `quests.json` 등 자유롭게 추가할 수 있다.

### 규칙

- 파일명이 컨텍스트 키가 된다: `world.json` → `{{world.xxx}}`, `items.json` → `{{items.xxx}}`
- `variables.json`의 값은 루트 레벨에 주입된다 (`{{location}}`, `{{hp}}` 등)
- 커스텀 데이터 파일은 파일명 키 아래에 주입된다 (`{{world.locations}}`, `{{items.weapons}}` 등)
- 파일이 변경되면 패널이 자동 재렌더링된다 (파일 감시 동작)
- 다음 시스템 파일은 자동 로드 대상에서 제외된다: `variables.json`, `session.json`, `builder-session.json`, `comfyui-config.json`, `layout.json`, `chat-history.json`, `character-tags.json`
- AI도 세션 중에 데이터 파일을 읽고 수정할 수 있다 (대화 맥락에 활용)

### variables.json vs 커스텀 데이터 파일

| | `variables.json` | 커스텀 데이터 파일 |
|---|---|---|
| 용도 | 매 턴 변하는 동적 상태 | 세계관, 아이템, NPC 등 정적/반정적 데이터 |
| 템플릿 접근 | `{{변수명}}` (루트) | `{{파일명.키}}` (네임스페이스) |
| 변경 주체 | AI가 매 턴 갱신 | AI가 필요 시 갱신, 또는 패널 브릿지로 갱신 |
| Bridge API | `__panelBridge.updateVariables()` | `__panelBridge.updateData()` |

---

## 인터랙티브 패널

패널 HTML 내에서 `<script>` 태그를 사용할 수 있다. 스크립트는 Shadow DOM 안에서 실행되지만 `window` 객체를 공유하므로, `window.__panelBridge` API를 통해 앱과 상호작용할 수 있다.

### Bridge API

| 메서드/속성 | 설명 |
|---|---|
| `__panelBridge.sendMessage(text)` | 채팅에 사용자 메시지를 전송한다. AI가 이 메시지에 응답한다. **동기 실행** (dispatchEvent). |
| `__panelBridge.fillInput(text)` | 입력창의 커서 위치에 텍스트를 삽입한다. 메시지를 보내지 않으므로 사용자가 추가 텍스트를 입력한 후 직접 전송할 수 있다. |
| `__panelBridge.updateVariables(patch)` | `variables.json`을 부분 업데이트한다. 패널이 자동 재렌더링된다. `patch`는 `{ key: value }` 객체. |
| `__panelBridge.updateData(fileName, patch)` | 커스텀 데이터 파일을 부분 업데이트한다. `fileName`은 확장자 포함 (예: `"inventory.json"`). `patch`는 `{ key: value }` 객체. |
| `__panelBridge.updateLayout(patch)` | `layout.json`을 deep merge로 부분 업데이트한다. 패널 배치, 독 크기, 테마 등을 실시간 변경할 수 있다. `patch`는 `layout.json`과 동일한 구조의 객체. 예: `{ panels: { dockWidth: 500 } }`. |
| `__panelBridge.queueEvent(header)` | 다음 사용자 메시지에 이벤트 헤더를 첨부한다. 큐에 쌓이며, 사용자가 다음 메시지를 보낼 때 AI에게 전달되는 텍스트 앞에 자동 prepend된다. OOC 메시지에는 첨부되지 않는다. **async** (서버 fetch). |
| `__panelBridge.runTool(name, args)` | 서버사이드 커스텀 툴을 실행한다. `name`은 `tools/` 폴더 내 `.js` 파일명 (확장자 제외). `args`는 툴에 전달할 인자 객체. 반환값은 `{ ok, result }`. |
| `__panelBridge.showPopup(template, opts?)` | 팝업 이펙트를 큐에 추가한다. `template`은 `popups/` 폴더 내 `.html` 파일명 (확장자 제외). `opts`는 `{ duration?: number, vars?: object }`. 현재 큐에 append되어 순차 재생된다. |
| `__panelBridge.showToast(text, opts?)` | 토스트 알림을 표시한다. 화면 우측 하단에 비차단형으로 나타나며, 여러 개가 스택으로 쌓인다. 클릭하면 즉시 닫힌다. `opts`는 `{ duration?: number }` (기본 3000ms). CSS 변수 `--toast-bg`, `--toast-color`, `--toast-border`, `--toast-shadow`로 스타일 커스터마이즈 가능. |
| `__panelBridge.confirm(message, opts?)` | 확인 다이얼로그를 표시한다. `Promise<boolean>`을 반환 (true = 확인, false = 취소). `message`는 HTML 지원. `opts`는 `{ yesText?: string, noText?: string }` (기본 "확인"/"취소"). 배경 클릭 시 취소. 테마 색상 자동 적용 (`--accent`). 사용 예: `var ok = await __panelBridge.confirm('이동하시겠습니까?', { yesText: '이동', noText: '취소' })` |
| `__panelBridge.openModal(name, mode?)` | 모달/독 패널을 연다. `name`은 패널 이름 (숫자 프리픽스 제외, 예: `"schedule"`). `mode`는 `"dismissible"` (기본) 또는 `true` (필수, 닫기 불가). 모달 그룹이 설정된 경우 같은 그룹의 다른 모달은 자동으로 닫힌다. |
| `__panelBridge.closeModal(name)` | 모달/독 패널을 닫는다. |
| `__panelBridge.closeAllModals(except?)` | 모든 모달을 닫는다. `except`는 닫지 않을 패널 이름 (문자열 또는 배열). |
| `__panelBridge.on(event, handler)` | 브릿지 이벤트를 구독한다. 반환값은 구독 해제 함수. 이벤트 목록은 아래 "브릿지 이벤트" 섹션 참조. |
| `__panelBridge.data` | 전체 템플릿 컨텍스트 객체 (읽기 전용). `variables.json` 값 + 커스텀 데이터 파일이 합쳐져 있다. |
| `__panelBridge.sessionId` | 현재 세션 ID (읽기 전용) |
| `__panelBridge.isStreaming` | AI가 현재 응답 중인지 여부 (읽기 전용, boolean) |

### 브릿지 이벤트

`__panelBridge.on(event, handler)` 로 구독할 수 있는 이벤트 목록:

| 이벤트 | detail | 설명 |
|--------|--------|------|
| `turnStart` | 없음 | AI가 응답을 시작했을 때 (스트리밍 시작) |
| `turnEnd` | 없음 | AI 응답이 완료되어 사용자 턴이 되었을 때 |
| `imageUpdated` | `{ filename: string }` | 세션 이미지 파일이 새로 생성되거나 덮어씌워졌을 때 |

```html
<script>
  // AI 응답 완료 시 최신 데이터로 UI 갱신
  const off = __panelBridge.on('turnEnd', () => {
    const d = __panelBridge.data;
    shadow.querySelector('.hp').textContent = d.hp;
  });

  // 이미지 갱신 감지
  __panelBridge.on('imageUpdated', (detail) => {
    const img = shadow.querySelector(`img[data-name="${detail.filename}"]`);
    if (img) img.src = img.src.replace(/[?&]_t=\d+/, '') + '?_t=' + Date.now();
  });
</script>
```

`on()`의 반환값은 구독 해제 함수다. 패널이 재렌더링되면 스크립트도 다시 실행되므로, `autoRefresh: false`가 아닌 패널에서는 이벤트가 중복 등록될 수 있다. 필요하면 반환된 함수로 이전 구독을 해제하라.

### 이미지 클릭 동작

패널 내 `<img>` 요소를 클릭하면 기본적으로 풀스크린 이미지 뷰어(ImageModal)가 열린다. 커스텀 클릭 핸들링이 필요한 이미지에는 `data-no-zoom` 속성을 추가하면 기본 zoom 핸들러를 건너뛴다. 이미지 자체 또는 부모 요소에 설정할 수 있다.

```html
<!-- 기본: 클릭 시 풀스크린 뷰어 -->
<img src="scene.png" />

<!-- 커스텀 핸들링: zoom 비활성화 -->
<img src="icon.png" data-no-zoom onclick="selectItem()" />

<!-- 컨테이너 단위 -->
<div data-no-zoom>
  <img src="a.png" onclick="handle1()" />
  <img src="b.png" onclick="handle2()" />
</div>
```

이미지 링크(`<a>` 태그)에도 동일하게 적용된다.

### 세션 이미지 리소스 사용

세션의 `images/` 디렉토리에 저장된 이미지(ComfyUI, Gemini 등으로 생성)를 패널에서 사용할 수 있다.

**Handlebars 방식** (권장 — 간단한 `<img>` 태그):
```html
<img src="{{__imageBase}}tavern-bg.png" />
```
`{{__imageBase}}`는 이미지 서빙 경로로 자동 치환된다. 세션에서는 `/api/sessions/{id}/files?path=images/`, 빌더에서는 `/api/personas/{name}/images?file=`로 설정된다. **파일명만 붙이면 된다** (`images/` 프리픽스 불필요).

**JavaScript 방식** (동적 이미지 교체 시):
```html
<script>
  const base = __panelBridge.data.__imageBase;
  const img = shadow.querySelector('.scene-img');
  img.src = base + 'scene.png';
</script>
```

**활용 예시:**
- 패널 배경: `background-image: url({{__imageBase}}panel-bg.png)`
- 장소 아이콘: 현재 `location` 변수에 따라 동적 교체
- 아이템 이미지: 인벤토리 패널에서 아이템별 이미지 표시

### `__panelBridge.data` 활용

Handlebars 없이 JS만으로 데이터를 가공하고 렌더링할 수 있다:

```html
<div class="dest-list"></div>

<script>
  const d = __panelBridge.data;

  // variables.json 값: d.location, d.gold, d.hp 등
  // 커스텀 데이터: d.world (world.json), d.items (items.json) 등

  // JS로 자유롭게 필터링/정렬
  const nearby = d.world.locations
    .filter(loc => loc.name !== d.location)
    .sort((a, b) => a.distance - b.distance);

  shadow.querySelector('.dest-list').innerHTML = nearby
    .map(loc => `<button class="dest" data-name="${loc.name}">${loc.name} (${loc.distance}일)</button>`)
    .join('');

  // 버튼 클릭 → 채팅 전송도 조합 가능
  shadow.querySelectorAll('.dest').forEach(btn => {
    btn.addEventListener('click', () => {
      __panelBridge.sendMessage(`${btn.dataset.name}(으)로 이동하겠습니다`);
    });
  });
</script>
```

Handlebars와 혼용도 가능하다. 정적 부분은 `{{변수}}`로, 동적 로직이 필요한 부분은 `<script>` + `__panelBridge.data`로 처리하면 된다.

### ⚠️ JS-only 패널의 데이터 의존성 선언

**중요**: Handlebars 변수(`{{...}}`)를 전혀 사용하지 않고 `<script>` + `__panelBridge.data`만으로 렌더링하는 패널은, 데이터가 변경되어도 **재렌더링되지 않는다.**

이유: DockPanel 컴포넌트는 렌더링된 HTML 문자열이 달라졌을 때만 shadow DOM을 갱신한다. Handlebars 변수가 없으면 데이터가 변해도 HTML이 동일하므로 메모이제이션에 의해 스킵된다.

**해결**: 패널이 의존하는 변수를 HTML 주석으로 선언한다. 이 주석은 화면에 표시되지 않지만, Handlebars가 평가하면서 HTML 문자열을 변경시켜 재렌더링을 트리거한다.

```html
<!-- deps: {{location}} {{current_room}} {{time}} -->

<div id="root"></div>
<script>
  var d = __panelBridge.data;
  // d.location, d.current_room 등을 사용하여 렌더링
  shadow.getElementById('root').innerHTML = ...;
</script>
```

이것은 React의 `useMemo` 의존성 배열과 같은 개념이다:
- `<!-- deps: {{location}} -->` → location이 변할 때만 재렌더
- `<!-- deps: {{location}} {{time}} -->` → location 또는 time이 변할 때 재렌더

**규칙:**
- JS-only 패널은 반드시 `<!-- deps: ... -->` 주석을 포함하라
- `__panelBridge.data`에서 읽는 변수 중, 변경 시 UI 갱신이 필요한 것만 나열하라
- Handlebars를 본문에 하나라도 쓰는 패널은 이미 자연스럽게 재렌더되므로 불필요하다

### Shadow DOM 내 요소 접근

패널의 `<script>` 블록은 시스템이 `new Function("shadow", code)`로 감싸서 실행한다.
`shadow`는 Shadow Root 참조로 자동 주입되며, 스코프도 자동 격리된다.
따라서 `document.currentScript.getRootNode()` 호출과 IIFE 래핑은 불필요하다.

스크립트는 Shadow DOM 안에서 실행되므로, `document.querySelector` 대신 자동 주입된 `shadow`를 사용하여 요소를 찾아야 한다:

```html
<script>
  const btn = shadow.querySelector('.my-button');
</script>
```

**⚠ 인라인 이벤트 핸들러 사용 금지:**

`onclick="myFunc()"` 같은 인라인 핸들러는 Shadow DOM에서 **동작하지 않는다.** 인라인 핸들러는 전역 스코프에서 함수를 찾는데, 패널 스크립트는 격리된 Shadow DOM 스코프에서 실행되므로 `ReferenceError: xxx is not defined` 오류가 발생한다.

```html
<!-- ❌ 잘못된 방법 — Shadow DOM에서 함수를 찾지 못함 -->
<button onclick="doSomething()">클릭</button>
<script>
  function doSomething() { ... }
</script>

<!-- ✅ 올바른 방법 — data 속성 + addEventListener -->
<button data-action="something">클릭</button>
<script>
  shadow.querySelectorAll('[data-action]').forEach(function(el) {
    el.addEventListener('click', function() {
      // el.dataset.action 으로 분기
    });
  });
</script>
```

### A) 선택지 → 도구 처리 + 이벤트 큐 (권장)

**선택이 상태 변경을 동반하는 경우의 권장 패턴.** 패널이 도구(`runTool`)로 상태를 즉시 반영하고, 이벤트 큐(`queueEvent`)로 AI에게 결과를 알린다. AI가 별도 턴을 소모하지 않으며, 사용자의 다음 메시지에 이벤트가 자연스럽게 포함된다.

```html
<button class="choice-btn" data-choice="optionA">선택지 A</button>
<button class="choice-btn" data-choice="optionB">선택지 B</button>

<script>
  shadow.querySelectorAll('[data-choice]').forEach(function(el) {
    el.addEventListener('click', async function() {
      var choice = el.dataset.choice;

      // 1) 도구로 즉시 상태 반영 (변수 업데이트, 모달 닫기 등)
      await __panelBridge.runTool('apply-choice', { choice: choice });

      // 2) 이벤트 큐에 결과 등록 — 다음 유저 메시지에 헤더로 포함됨
      __panelBridge.queueEvent('[선택] ' + choice + '을(를) 선택했습니다');
    });
  });
</script>
```

**`sendMessage`와의 차이:**
| | `sendMessage` | `runTool` + `queueEvent` |
|---|---|---|
| AI 턴 소모 | ✅ 즉시 AI 응답 트리거 | ❌ 다음 유저 메시지까지 대기 |
| 상태 반영 | AI가 처리 (비결정적) | 도구가 즉시 처리 (결정적) |
| 사용자 흐름 | 강제 턴 삽입 | 자연스러운 대화 흐름 유지 |
| 적합한 경우 | 단순 대사 전송, 상태 변경 없음 | 점수/인벤토리/스탯 변경 동반 |

**언제 어떤 패턴을 쓸 것인가:**
- 선택이 **상태를 바꾸는** 경우 → `runTool` + `queueEvent` (권장)
- 선택이 단순히 **대사를 보내는** 경우 → `sendMessage`

### A-legacy) 선택지 버튼 → 채팅 전송

AI가 선택지를 패널에 표시하고, 사용자가 클릭하면 채팅으로 전송되는 패턴. 상태 변경이 없는 단순 선택지에 적합:

```html
<style>
  .choices { display: flex; flex-direction: column; gap: 6px; }
  .choice-btn {
    background: #1e2d4a; border: 1px solid #2a3a5e; border-radius: 8px;
    padding: 8px 12px; color: #e0e0e0; cursor: pointer; text-align: left;
    font-size: 12px; transition: all 0.2s;
  }
  .choice-btn:hover { background: #2a3a5e; border-color: #6c63ff; }
</style>

<div class="choices">
  {{#each choices}}
  <button class="choice-btn" data-action="{{this}}">{{this}}</button>
  {{/each}}
</div>

<script>
  shadow.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      window.__panelBridge.sendMessage(btn.dataset.action);
    });
  });
</script>
```

### B) 엔진을 통한 상태 변경 (상점, 소모품 등)

대화 없이 서버 엔진으로 상태를 변경하는 패턴. 엔진이 규칙(가격, 소지금 검증, 효과 적용)을 처리하므로 패널은 호출만 한다:

```html
<style>
  .shop-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 0; border-bottom: 1px solid #1a1a2e;
  }
  .buy-btn {
    background: #6c63ff; color: white; border: none; border-radius: 6px;
    padding: 4px 10px; font-size: 11px; cursor: pointer;
  }
  .buy-btn:hover { opacity: 0.8; }
  .buy-btn:disabled { opacity: 0.3; cursor: not-allowed; }
</style>

<div class="shop-item">
  <span>회복 포션 (50G)</span>
  <button class="buy-btn" data-item="회복포션">구매</button>
</div>

<script>
  shadow.querySelectorAll('.buy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      // 엔진이 소지금 검증 + 인벤토리 추가 + 골드 차감을 한 번에 처리
      const res = await __panelBridge.runTool('engine', {
        action: 'buy_item', item: btn.dataset.item
      });
      if (!res.result?.success) {
        btn.disabled = false;
        // 실패 시 피드백 (골드 부족 등)
      }
    });
  });
</script>
```

`updateVariables`로 패널에서 직접 값을 조작하는 것도 가능하지만, 규칙 검증이 필요한 경우(소지금 부족, 인벤토리 가득 참 등) 엔진에 위임하는 것이 안전하다.

### C) 클라이언트 인터랙션 (탭, 아코디언 등)

서버와 통신 없이 패널 내 UI만 전환하는 패턴:

```html
<style>
  .tab-bar { display: flex; gap: 2px; margin-bottom: 8px; }
  .tab { padding: 4px 10px; font-size: 11px; border-radius: 4px; cursor: pointer;
         background: transparent; color: #8888a0; border: none; }
  .tab.active { background: #1e2d4a; color: #e0e0e0; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
</style>

<div class="tab-bar">
  <button class="tab active" data-tab="stats">능력치</button>
  <button class="tab" data-tab="items">아이템</button>
</div>
<div class="tab-content active" id="stats">능력치 내용...</div>
<div class="tab-content" id="items">아이템 내용...</div>

<script>
  shadow.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      shadow.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      shadow.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      shadow.getElementById(tab.dataset.tab)?.classList.add('active');
    });
  });
</script>
```

### 주의사항

- 패널은 `variables.json` 변경 시 **전체 재렌더링**된다. 스크립트와 DOM 상태가 초기화되므로, 영속적 상태는 `variables.json`에 저장하라.
- **자동 갱신 제어**: 애니메이션이나 연출이 있는 패널은 `layout.json`의 `panels.autoRefresh`로 자동 갱신을 끌 수 있다. `autoRefresh: false`인 패널은 변수/데이터 변경 및 AI 턴 종료 시에도 재렌더링되지 않으며, 해당 패널의 HTML 템플릿 파일이 직접 수정될 때만 갱신된다. 아래 "자동 갱신 제어" 섹션 참조.
- `updateVariables`는 병합(merge)이다. 전달한 키만 덮어쓴다.
- `sendMessage`로 전송된 메시지는 일반 사용자 메시지와 동일하게 처리된다.
- **`queueEvent` → `sendMessage` 순서 주의**: `queueEvent`는 **async fetch**이고 `sendMessage`는 **동기 dispatchEvent**다. `queueEvent`를 먼저 호출해도 `await` 하지 않으면 `sendMessage`가 먼저 실행되어 이벤트 헤더가 메시지에 포함되지 않는다. 반드시 `await queueEvent(...)` 후 `sendMessage(...)`를 호출하라.
  ```javascript
  // ❌ 잘못된 순서 (sendMessage가 먼저 실행됨)
  __panelBridge.queueEvent('[이벤트]');
  __panelBridge.sendMessage('메시지');

  // ✅ 올바른 순서
  await __panelBridge.queueEvent('[이벤트]');
  __panelBridge.sendMessage('메시지');
  ```
- **Shadow Root 접근**: `shadow`가 자동 주입된다. `document.currentScript.getRootNode()`나 IIFE 래핑은 불필요하다.

---

## 서버사이드 커스텀 툴

서버에서 직접 결정적 로직을 실행하는 스크립트. 패널(`runTool`)과 AI(MCP `run_tool`)에서 모두 호출할 수 있다.

### 툴 파일 구조

```
personas/{name}/tools/
├── engine.js       # 중앙 엔진 (권장 — 하나의 디스패처로 모든 액션 처리)
├── helpers.js      # 엔진이 require하는 유틸 (선택)
└── standalone.js   # 엔진과 별개인 독립 기능 (선택)
```

`tools/` 폴더에 `.js` 파일을 넣으면 파일명이 툴 이름이 된다. 세션 생성 시 자동 복사되며, 양방향 싱크를 지원한다.

**권장 구조:** 기능별로 `attack.js`, `craft.js`, `travel.js` 등을 분리하기보다, **하나의 `engine.js`에 액션 디스패처**를 두는 것이 좋다. 규칙이 한 곳에 모이므로 액션 간 부수 효과(이동하면 시간 경과, 전투하면 내구도 감소 등)를 일관되게 처리할 수 있다.

### 스크립트 인터페이스

각 `.js` 파일은 단일 async 함수를 `module.exports`로 내보낸다:

```javascript
// tools/engine.js — 중앙 엔진 예시
module.exports = async function(context, args) {
  // context.variables  — variables.json 내용 (읽기용 사본)
  // context.data       — 커스텀 데이터 파일들 { inventory: {...}, world: {...} }
  //                      (키는 파일명에서 .json 제거된 형태)
  // context.sessionDir — 세션 디렉토리 절대 경로 (직접 파일 I/O 가능)

  const { action, ...params } = args;
  // action에 따라 적절한 핸들러로 분기
  // ...
};
```

### 반환값

| 필드 | 타입 | 설명 |
|------|------|------|
| `variables` | `Record<string, unknown>` | `variables.json`에 shallow merge. 생략 가능. |
| `data` | `Record<string, Record<string, unknown>>` | 파일명(확장자 포함) → 패치 객체. 각 파일에 shallow merge. 생략 가능. |
| `result` | `unknown` | 패널에 그대로 전달되는 임의 데이터. 생략 가능. |
| `noActionLog` | `boolean` | `true`이면 이 실행을 액션 히스토리에 기록하지 않는다. 아래 "액션 히스토리" 섹션 참조. |

`variables`나 `data`가 있으면 서버가 파일에 반영 후 패널이 자동 재렌더링된다.

### 패널에서 호출

```javascript
// 엔진에 액션 전달
const res = await __panelBridge.runTool('engine', { action: 'attack', target: 'goblin' });
// res = { ok: true, result: { success: true, damage: 7 } }
```

### D) 엔진 디스패처 종합 예시

하나의 `engine.js`로 전투, 아이템, 이동, 시간을 통합 관리하는 패턴:

```javascript
// tools/engine.js
const ACTIONS = {
  // --- 시간 ---
  advance_time(ctx, args) {
    const { hours = 1 } = args;
    let h = (ctx.variables.hour || 0) + hours;
    let day = ctx.variables.day || 1;
    while (h >= 24) { h -= 24; day++; }
    const period = h < 6 ? '새벽' : h < 12 ? '오전' : h < 18 ? '오후' : '밤';
    return { variables: { hour: h, day, period } };
  },

  // --- 이동 ---
  move(ctx, args) {
    const { destination } = args;
    const travelHours = ctx.data.world?.travelTimes?.[destination] || 1;
    // 이동 → 시간도 경과 (액션 조합)
    const timeResult = ACTIONS.advance_time(ctx, { hours: travelHours });
    return {
      variables: { ...timeResult.variables, location: destination },
      result: { success: true, destination, travelHours },
    };
  },

  // --- 아이템 사용 ---
  use_item(ctx, args) {
    const { item, quantity = 1 } = args;
    const inv = { ...ctx.data.inventory?.items };
    if ((inv[item] || 0) < quantity) {
      return { result: { success: false, message: `${item} 부족` } };
    }
    inv[item] -= quantity;
    if (inv[item] <= 0) delete inv[item];

    // 아이템 효과를 데이터에서 조회 (코드에 하드코딩하지 않음)
    const effects = ctx.data.items?.effects?.[item] || {};
    const vars = {};
    for (const [stat, delta] of Object.entries(effects)) {
      const max = ctx.variables[`${stat}_max`] || Infinity;
      vars[stat] = Math.min(max, (ctx.variables[stat] || 0) + delta);
    }

    return {
      variables: vars,
      data: { "inventory.json": { items: inv } },
      result: { success: true, item, quantity, effects: vars },
    };
  },

  // --- 전투 ---
  attack(ctx, args) {
    const { target } = args;
    const enemies = ctx.data.world?.enemies || [];
    const enemy = enemies.find(e => e.name === target);
    if (!enemy || enemy.hp <= 0) {
      return { result: { success: false, message: `${target}을(를) 공격할 수 없습니다.` } };
    }

    const atk = ctx.variables.attack || 10;
    const damage = Math.floor(Math.random() * atk) + 1;
    const crit = Math.random() < 0.15;
    const finalDmg = crit ? damage * 2 : damage;
    const newHp = Math.max(0, enemy.hp - finalDmg);

    const updatedEnemies = enemies.map(e =>
      e.name === target ? { ...e, hp: newHp } : e
    );

    return {
      variables: { lastAction: `${target} 공격 → ${finalDmg}dmg${crit ? ' CRIT' : ''}` },
      data: { "world.json": { enemies: updatedEnemies } },
      result: { success: true, damage: finalDmg, crit, targetHp: newHp },
    };
  },

  // --- 제작 ---
  craft(ctx, args) {
    const { recipe } = args;
    const recipes = ctx.data.recipes?.list || [];
    const inv = ctx.data.inventory?.items || {};

    const r = recipes.find(x => x.name === recipe);
    if (!r) return { result: { success: false, message: '알 수 없는 레시피' } };

    for (const [item, qty] of Object.entries(r.materials)) {
      if ((inv[item] || 0) < qty) {
        return { result: { success: false, message: `${item} ${qty}개 필요 (보유: ${inv[item] || 0})` } };
      }
    }

    const newItems = { ...inv };
    for (const [item, qty] of Object.entries(r.materials)) newItems[item] -= qty;
    newItems[r.result] = (newItems[r.result] || 0) + 1;

    return {
      data: { "inventory.json": { items: newItems } },
      result: { success: true, crafted: r.result },
    };
  },

  // --- 외형 변경 ---
  change_outfit(ctx, args) {
    const { outfit, description } = args;
    return { variables: { outfit, outfitDescription: description } };
  },
};

module.exports = async function(context, args) {
  const { action, ...params } = args;
  const handler = ACTIONS[action];
  if (!handler) {
    return { result: { success: false, message: `알 수 없는 액션: ${action}` } };
  }
  return handler(context, params);
};
```

패널에서 사용:

```html
<!-- 전투 패널 -->
{{#each world.enemies}}
  {{#if (gt this.hp 0)}}
  <div class="enemy-row">
    <span>{{this.name}} — HP {{this.hp}}/{{this.maxHp}}</span>
    <button class="atk-btn" data-target="{{this.name}}">공격</button>
  </div>
  {{/if}}
{{/each}}
<div class="battle-log" id="log"></div>

<script>
  shadow.querySelectorAll('.atk-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await __panelBridge.runTool('engine', {
        action: 'attack', target: btn.dataset.target
      });
      const log = shadow.querySelector('#log');
      if (res.result?.success) {
        log.textContent = `${res.result.damage} 데미지!${res.result.crit ? ' 크리티컬!' : ''}`;
        log.style.color = res.result.crit ? '#f1c40f' : '#4dff91';
        // AI에게 전투 결과 알림
        await __panelBridge.queueEvent(
          `[전투: ${btn.dataset.target}에게 ${res.result.damage}dmg, 남은HP ${res.result.targetHp}]`
        );
      }
    });
  });
</script>
```

### E) 개별 스크립트가 유용한 경우

모든 것을 `engine.js`에 넣을 필요는 없다. 엔진과 무관한 **독립적 유틸리티**는 별도 파일로 분리해도 된다:

- 랜덤 이벤트 생성기 (`random-event.js`)
- 외부 API 호출 래퍼
- 데이터 마이그레이션/정리 스크립트

기준: **게임 상태를 변경하는 규칙 기반 로직**은 엔진에, **상태와 무관한 유틸리티**는 개별 스크립트에.

### 커스텀 툴 주의사항

- 스크립트는 서버 프로세스 내에서 실행된다. 무한루프 주의.
- 실행 제한 시간: 10초. 초과 시 에러 반환.
- `context.variables`와 `context.data`는 읽기용 사본이다. 직접 수정해도 파일에 반영되지 않으며, 반드시 `return`의 `variables`/`data`로 반환해야 한다.
- `data` 반환의 키는 파일명 확장자를 포함해야 한다 (예: `"world.json"`, `"inventory.json"`).
- `session.json`, `layout.json` 등 시스템 파일은 수정할 수 없다.
- 여러 버튼의 빠른 연타는 race condition을 유발할 수 있다. 클릭 시 `btn.disabled = true`로 중복 방지를 권장한다.

### 액션 히스토리 & Hint Rules

프론트엔드에서 실행된 툴 액션은 자동 기록되어 다음 사용자 메시지에 `[ACTION_LOG]`로 전달된다. `hint-rules.json`이 있으면 현재 상태 스냅샷도 `[STATE]`로 매 메시지에 전달된다. 반환값에 `noActionLog: true`를 포함하면 해당 실행의 기록을 제외할 수 있다.

**메시지 조립 순서:**
```
{이벤트 큐 헤더}     ← queueEvent()
[STATE] ...          ← hint-rules.json 스냅샷 (있을 때만)
[ACTION_LOG] ...     ← 툴 실행 히스토리 (있을 때만)
(사용자 메시지)
```

상세 설정 가이드(`hint-rules.json` 스키마, `noActionLog` 사용법 등)는 빌더 프롬프트의 해당 섹션을 참조.

---

## 팝업 이펙트 시스템

화면 중앙에 일시적으로 표시되는 연출용 이펙트. 진행상황 갱신, 성과 달성, 이벤트 발생 등 주목할 만한 정보를 극적으로 표현한다.

### 팝업 템플릿

`popups/` 디렉토리에 Handlebars HTML 파일로 작성한다. 패널과 동일한 헬퍼 함수를 사용할 수 있다.

```
personas/{name}/
  popups/
    level-up.html
    item-acquired.html
    quest-start.html
```

### 팝업 큐 (`variables.json`의 `__popups`)

```json
{
  "__popups": [
    { "template": "level-up", "duration": 4000 },
    { "template": "item-acquired", "duration": 3000, "vars": { "itemName": "신비한 검" } }
  ]
}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `template` | string | O | `popups/` 디렉토리의 파일명 (확장자 없이) |
| `duration` | number | X | 표시 시간(ms). 기본값 4000ms |
| `vars` | object | X | 해당 팝업에만 적용할 추가 변수. 기존 variables 컨텍스트에 머지됨 |

### 동작 방식

- **큐 기반**: 배열 순서대로 하나씩 표시 → 자동 소멸 → 다음 팝업
- **턴 단위 유지**: 새로고침해도 큐에 남아있으면 다시 재생
- **자동 클리어**: 다음 비-OOC 메시지 전송 시 서버/클라이언트 양쪽에서 클리어. OOC 메시지는 클리어하지 않음
- **테마 연동**: `layout.json`의 theme 컬러를 기반으로 그라디언트/글로우 자동 적용
- **CSS 변수**: 팝업 템플릿 내부에서 `--popup-primary`, `--popup-glow` CSS 변수를 사용 가능

### 애니메이션

- **진입**: scale 0.7 → 1.0 + fade in + 배경 딤 (~300ms)
- **퇴장**: scale 1.0 → 0.9 + fade out + 배경 딤 해제 (~300ms)

### 트리거 방법

**AI (MCP)에서:**
```
run_tool("engine", { action: "trigger_popup", template: "level-up", vars: { level: 10 } })
```
또는 `update_variables`로 `__popups` 배열을 직접 설정.

**패널 스크립트에서:**
```javascript
await __panelBridge.showPopup("level-up", { duration: 5000, vars: { level: 10 } });
```

**엔진 스크립트에서:**
```javascript
// tools/engine.js 내 액션에서 반환
return {
  variables: { __popups: [{ template: "item-acquired", duration: 3000, vars: { itemName: "신비한 검" } }] },
};
```

### 팝업 템플릿 예시

```html
<!-- popups/level-up.html -->
<style>
  .popup-content { text-align: center; padding: 12px; }
  .icon { font-size: 48px; margin-bottom: 12px; }
  .title { font-size: 22px; font-weight: 800; margin-bottom: 6px; }
  .desc { font-size: 14px; opacity: 0.85; }
  .level { font-size: 36px; font-weight: 900; color: var(--popup-primary); margin-top: 8px; }
</style>

<div class="popup-content">
  <div class="icon">⚔️</div>
  <div class="title">LEVEL UP!</div>
  <div class="desc">새로운 레벨에 도달했습니다</div>
  <div class="level">Lv. {{level}}</div>
</div>
```

### 팝업 템플릿 작성 규칙

**중요: PopupEffect 컴포넌트가 외부 카드를 자동 제공한다.** 팝업 HTML은 카드 내부 콘텐츠만 작성하라.

컴포넌트가 자동으로 감싸주는 것:
- 딤 배경 오버레이 (`position: fixed`, 화면 전체)
- 카드 컨테이너 (`maxWidth: 480px`, `width: 90vw`, `padding: 24px`, `border-radius: 16px`)
- 테마 기반 gradient 배경, box-shadow, glow
- 진입/퇴장 애니메이션 (scale + opacity)
- Shadow DOM 격리

**팝업 HTML에서 하지 말 것:**
- ❌ `position: fixed` 또는 풀스크린 래퍼 — 컴포넌트가 이미 처리함
- ❌ 자체 배경/카드 컨테이너 — 이중 카드가 되어 레이아웃 깨짐
- ❌ `width: 100vw`, `height: 100vh` 등 뷰포트 크기 참조 — Shadow DOM 안에서 의도대로 동작하지 않음

**팝업 HTML에서 해야 할 것:**
- ✅ 콘텐츠만 작성 (아이콘, 제목, 설명 등)
- ✅ `text-align: center` + flex column 레이아웃 권장
- ✅ CSS 변수 `--popup-primary`, `--popup-glow` 활용
- ✅ 애니메이션은 개별 요소 단위로 (카드 전체 애니메이션은 컴포넌트가 처리)

### 주의사항

- 팝업 표시 중 배경은 클릭할 수 없다 (딤 오버레이가 입력을 차단)
- 여러 팝업이 동시에 트리거되면 큐잉되어 순차 재생된다
- 존재하지 않는 템플릿을 참조하면 해당 항목은 무시(skip)된다
- 팝업은 모달 패널(z-index 9998+)보다 위에 표시된다 (z-index 10100+)

---

## 토스트 알림

팝업 이펙트의 경량 버전. 화면 우측 하단에 비차단형 알림을 표시한다. 여러 개가 동시에 스택으로 쌓이며, 클릭하면 즉시 닫힌다.

### 사용법

**패널 스크립트에서:**
```javascript
__panelBridge.showToast("골드 100을 획득했습니다!");
__panelBridge.showToast("레벨 업!", { duration: 5000 });
```

### 팝업과의 차이

| | 팝업 (`showPopup`) | 토스트 (`showToast`) |
|---|---|---|
| 위치 | 화면 중앙, 딤 오버레이 | 우측 하단, 오버레이 없음 |
| 동시 표시 | 1개씩 순차 재생 | 여러 개 스택 |
| 상호작용 차단 | O | X |
| 콘텐츠 | Handlebars HTML 템플릿 | 텍스트 |
| 기본 duration | 4000ms | 3000ms |

### 스타일 커스터마이즈

CSS 변수로 토스트 디자인을 오버라이드할 수 있다:

```css
:root {
  --toast-bg: rgba(0, 0, 0, 0.85);
  --toast-color: #fff;
  --toast-border: 1px solid rgba(255, 255, 255, 0.1);
  --toast-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
```

기본값은 세션 테마 컬러 기반으로 자동 생성된다.

---

## 인라인 패널 (채팅 내 삽입)

사이드바뿐 아니라 **채팅 메시지 안에** 패널을 삽입할 수 있다. `$IMAGE:path$`와 동일한 문법:

```
$PANEL:패널명$
```

- `패널명`은 패널 파일의 표시 이름이다 (숫자 prefix 제거 후). 예: `05-거래.html` → `$PANEL:거래$`
- 해당 위치에 패널의 렌더링된 HTML이 Shadow DOM으로 인라인 표시된다
- 인라인 패널도 `<script>` + `__panelBridge` API를 사용할 수 있다
- 패널은 현재 `variables.json` 기준으로 렌더링되므로, 변수가 바뀌면 인라인 패널도 자동 갱신된다

### 사용 예시

AI 응답 안에서:
```
물건들을 살펴보시겠어요?

$PANEL:거래$

마음에 드는 게 있으면 골라주세요.
```

### 인라인 vs 사이드바

| | 사이드바 패널 | 인라인 패널 |
|---|---|---|
| 표시 위치 | 우측/좌측/하단 고정 | 채팅 메시지 내 |
| 항상 표시 | O (세션 내내) | X (해당 메시지에서만) |
| 용도 | 상태, 프로필 등 상시 정보 | 선택지, 거래, 일회성 인터랙션 |
| `$PANEL:` 필요 | X (자동 표시) | O (AI가 태그 출력) |

### 패널 배치 타입 (`layout.json`의 `panels.placement`)

- `"left"` — 좌측 사이드바에 표시된다.
- `"right"` — 우측 사이드바에 표시된다.
- `"modal"` — 화면 중앙 오버레이로 표시된다. `__modals`로 on/off 제어. `true`이면 필수(닫기 불가), `"dismissible"`이면 자유롭게 닫을 수 있다. 여러 모달이 활성화되면 z-index가 증가하며 겹쳐 표시된다. ESC 키는 최상위 dismissible 모달만 닫는다. `__panelBridge.sendMessage()`는 모달 모드와 무관하게 항상 모달을 자동으로 닫는다.
- `"dock"` / `"dock-bottom"` — 채팅 영역과 입력창 사이에 전체 너비로 표시된다. `__modals`로 on/off 제어 (modal과 동일). 같은 방향의 여러 dock 패널이 활성화되면 탭으로 전환된다.
- `"dock-left"` / `"dock-right"` — 채팅 스크롤 영역 안에서 좌/우 하단에 float 형태로 표시된다. **`__modals`로 on/off 제어 (modal, dock과 동일).** `__modals`에 값이 없으면 표시되지 않는다. 문서에서 이미지 옆으로 텍스트가 밀리듯, 패널과 수직으로 겹치는 메시지들은 자동으로 너비가 줄어들어 패널 옆으로 배치된다. 패널 위쪽 메시지는 전체 너비를 사용한다. `position: sticky`로 스크롤 위치와 무관하게 항상 하단에 고정된다.
- **지정 없음** — 인라인. 채팅 본문 내 `$PANEL:이름$` 태그로 삽입된다.

### 모달 그룹 (`layout.json`의 `panels.modalGroups`)

동시에 열리면 안 되는 모달들을 그룹으로 묶을 수 있다. 한 그룹 내에서 `openModal()`로 모달을 열면 같은 그룹의 다른 모달은 자동으로 닫힌다.

```json
{
  "panels": {
    "modalGroups": {
      "gameplay": ["schedule", "advance", "competition"],
      "inventory": ["shop", "storage"]
    }
  }
}
```

- 그룹에 속하지 않는 모달은 독립적으로 동작한다
- `__panelBridge.openModal()` 및 `/api/sessions/[id]/modals` 엔드포인트 모두 그룹 로직을 적용한다
- `updateVariables({ __modals })` 직접 호출 시에는 그룹 로직이 적용되지 않으므로, `openModal()` / `closeModal()`을 사용하는 것을 권장한다

### 레이아웃 실시간 업데이트

`layout.json` 파일은 `panel-engine.ts`의 `fs.watch`로 감시된다. 파일이 변경되면 `layout:update` WebSocket 이벤트가 브로드캐스트되어, 프론트엔드에서 세션 재진입 없이 즉시 반영된다. `__panelBridge.updateLayout(patch)` 호출 시에도 동일한 경로로 전파된다.

### dock 크기 설정 (`layout.json`의 `panels`)

| 속성 | 설명 | 기본값 |
|---|---|---|
| `dockWidth` | dock-left/right 패널의 너비 (px). 생략 시 콘텐츠에 맞게 자동 조정. | auto (min 280px, max 50%) |
| `dockHeight` | 모든 dock 패널의 최대 높이 (px). | 50vh |
| `dockSize` | `dockHeight`의 하위호환 별칭. `dockHeight`가 우선한다. | 50vh |
| `showProfileImage` | 좌측 사이드바에 캐릭터 프로필 이미지를 표시할지 여부. | `true` |

### 자동 갱신 제어 (`layout.json`의 `panels.autoRefresh`)

기본적으로 모든 패널은 `variables.json`, 커스텀 데이터 파일 변경, AI 턴 종료 시 자동 재렌더링된다. 하지만 애니메이션, 전환 효과, 또는 스크립트 기반 연출이 있는 패널은 이 자동 갱신이 방해가 될 수 있다.

`panels.autoRefresh`에서 패널별로 자동 갱신을 끌 수 있다:

```json
{
  "panels": {
    "placement": { "상태": "right", "씬": "dock-left" },
    "autoRefresh": {
      "씬": false
    }
  }
}
```

| 값 | 동작 |
|---|---|
| `true` (기본값) | 변수/데이터 변경, AI 턴 종료 시마다 재렌더링 |
| `false` | 패널의 HTML 템플릿 파일(`panels/*.html`)이 직접 수정될 때만 재렌더링 |

**`autoRefresh: false`인 패널의 특성:**
- 변수가 바뀌어도 DOM이 초기화되지 않으므로 CSS 애니메이션, 스크립트 상태가 유지된다
- 최신 데이터가 필요하면 `__panelBridge.data`로 직접 읽어서 스크립트로 DOM을 갱신하라
- 초기 렌더링 시점의 데이터로 Handlebars 템플릿이 한 번만 평가된다

**사용 예시:** 씬 연출 패널, 배경 애니메이션 패널, 복잡한 인터랙티브 UI 등 DOM 초기화가 곤란한 패널에 적합하다.

---

## 패널 종류 예시

캐릭터에 따라 적절한 패널을 1~3개 생성한다:

- **상태 패널** (`01-상태.html`): 관계 수치 게이지, 위치/시간/날씨 태그
- **프로필 패널** (`02-프로필.html`): 캐릭터 간략 정보, 현재 복장, 표정
- **인벤토리 패널** (`03-인벤토리.html`): 소지품, 아이템 목록
- **퀘스트/목표 패널**: 진행 중인 이벤트나 과제
- **관계도 패널**: 다른 NPC와의 관계
- **특수 패널**: 캐릭터 고유 (마법 주문 목록, 수사 노트 등)
