# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | **한국어** | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **switchman 패밀리**, 같은 저자, 같은 조율 방침: [opencode-switchman](https://github.com/mrzturn/opencode-switchman)(OpenCode 원판) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman)(ZCode 이식판) · **dsh-switchman**(이 저장소, DeepSeek Harness 버전).

![dsh-switchman — 컨텍스트 수위가 전환수를 움직여 작업을 올바른 레인으로 던져 넣는다](docs/assets/hero.svg)

> 컨텍스트에 수도계량기를 달면, 작업이 스스로 레인을 찾습니다.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH) 플러그인입니다. 설치하고 나면 기본 모델은 "모든 걸 자기가 처리"하던 방식을 접고 디스패처가 됩니다: 수위를 재고, 레인을 고르고, 작업을 나눠주고, 결과를 검수합니다. 하는 일은 네 가지입니다:

**1. 컨텍스트 수위 제어.** 라운드마다 세션 token 을 실시간 계측합니다. soft(기본값 50k)는 위임을 권고하고, hard(90k)는 라운드당 읽기 예산을 줄여 마무리로 유도하며, force(130k)는 세션을 자동 백업해 압축으로 넘깁니다. 세션을 하루 종일 돌려도 컨텍스트가 자기 히스토리에 익사하는 일은 없습니다. 위임된 각 서브에이전트는 독립 하드 한도를 가지며, 넘으면 HANDOFF 요약을 남기고 퇴장합니다.

**2. 6 레인 디스패치.** economy / mechanical / main / hard / vision / review 여섯 개의 인지 레인: 설정 페이지에서 후보 모델을 고르고, 최강 우선으로 정렬하며(S/A/B/C 티어 앵커는 선택), 라우트마다 사고 강도를 고정할 수 있습니다 — 드롭다운 레벨 목록은 각 모델이 *실제로* 지원하는 것에서 직접 나오는 것이지 일반적인 세 단계가 아닙니다. `[SWITCHMAN:POOLS]` 추천 표가 프롬프트마다 기본 모델에 전달되어 모델이 이를 보고 일을 배정합니다. `enforce` 모드에서는 풀 밖 모델을 즉시 거부합니다. 세션의 DSH 설정이 명시적 서브에이전트 선택을 허가하지 않은 라우트는 추천 표와 설정 페이지 양쪽에 ⚠ 로 표시되어 DSH 설정(Subagents → model selection)에서 허가하도록 안내합니다 — 허가하지 않으면 에이전트는 암묵적 디스패치로 폴백합니다. 리뷰 독립성은 코드 **작성자**(diff 를 만들어낸 에이전트)의 모델을 기준으로 하며, 메인 세션의 모델이 아닙니다.

**3. 언어 기본 설정.** 답변·코드 주석·문서 세 종류에 각각 드롭다운 하나. 미설정이면 첫 사용 때 한 번 물어보고 영구 기억하며, 이후 모든 세션이 자동으로 따릅니다.

**4. 기본 위임 교리.** DSH 출하 시 탑재된 보수적 팀 정책("요청받을 때만 팀원 생성")을 대체합니다: 자잘한 일은 직접 손을 쓰고(읽기 <200줄, 변경 <50줄), 큰 작업은 기본적으로 위임합니다. 변경은 반드시 검증합니다 — 20줄 초과는 tester 에게, 300줄 초과 또는 핵심 로직을 건드린 변경은 코드 작성자와 다른 모델의 reviewer 에게(풀에서 마련할 수 없으면 DOWNGRADED 로 선언). "팀 쓰지 마"라고 한마디만 하면 즉시 물러납니다.

모델이 하나뿐인가요? 그래도 가치가 있습니다 — 수위 제어와 교리는 모델 개수를 전혀 신경 쓰지 않습니다.

## 번들 스킬

- **db-query** — MySQL / Redis 읽기 전용 검증: SQL을 돌려 레코드 대조, 캐시 키 / TTL 확인, 스토어 간 일관성 검사를 하고 쓰기는 일절 거부합니다. 최초 사용 시 초기화 필요(아래 참조).
- **git-commit-message** — 규범에 맞는 commit 문구 생성. 텍스트만 내보내고 git 은 절대 건드리지 않습니다.
- **requirement-docs** — 요구사항 분석 / PRD / 설계 문서의 통일 규범. 산출물은 `docs/requirements-and-design/` 에 아카이브합니다.

## 빠른 시작

1. **설치** — 아무 세션에서나 에이전트에게 실행시키거나, 웹 플러그인 관리 페이지에서:

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   또는 로컬 체크아웃에서(link 방식. 업데이트 반영 후 `remove_bundle` + `install_bundle` 재설치):

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   터미널에서 `dsh` CLI로도 설치할 수 있습니다 — DSH 실행 방식에 맞는 프로파일을 선택하세요:

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # 데스크톱 앱
   ```

2. **DSH 재시작** — 앱을 완전히 종료한 뒤 다시 엽니다(페이지 새로고침으로는 부족). 클라이언트 모듈 테이블이 이 bundle 을 인식하게 됩니다.

3. **설정 페이지 열기** — 설정 → dsh-switchman. 첫 화면은 언어 기본 설정입니다: 먼저 범위를 선택 — 프로필 전체 또는 프로젝트별(각 프로젝트의 `.switchman/lang.json`) — 그다음 답변 / 주석 / 문서 각각의 드롭다운으로 설정하며 각 항목 아래에 "현재: …" 상태 줄이 붙습니다. 설정하지 않아도 괜찮습니다 — 첫 사용 때 한 번 물어보고 기억합니다(질문 언어는 DSH UI 언어를 따릅니다).

   ![설정 페이지와 언어 기본 설정](docs/assets/conf-demo1.png)

4. **여섯 개 풀 채우기** — 각 풀 카드는 공급자별로 묶인 후보 모델을 보여줍니다. 원하는 것에 체크하세요. **수동 순서**에 체크하면 카드가 ↑ ↓ × 컨트롤이 달린 번호식 우선순위 목록으로 바뀝니다. 선택한 각 라우트 옆의 사고 강도 드롭다운 기본값은 "레인 따르기"이며, 고정하면 해당 모델이 실제 지원하는 레벨(Low / High / Max…)을 고를 수 있습니다. 요약 줄이 진행 상황을 실시간으로 반영합니다: "풀 설정 6/6 · 랭킹 3개 · 모드 조언". 선택했지만 DSH 설정이 명시적 서브에이전트 선택을 허가하지 않은 라우트에는 ⚠ 배지와 힌트가 붙습니다 — 이것도 DSH 설정(Subagents → model selection)에서 허가하세요. 그렇지 않으면 이 라우트를 명시적으로 지명한 에이전트는 거부되고 암묵적 디스패치로 폴백합니다.

   ![디스패치 풀 설정](docs/assets/conf-demo2.png)

5. **능력 랭킹과 수위** — 랭킹 표 번호는 곧 능력 순(최강이 먼저)이며 S/A/B/C 티어를 앵커할 수 있습니다. 실행 모드는 세 가지: `off` / 조언 / enforce(enforce = 풀 밖 모델 즉시 거부). 아래 수위 섹션은 token 사용량에 따라 단계적으로 동작을 조입니다: 세 단계 임계값, 1회당 읽기 예산, hard 모드 동작(제한 허용 / 차단), 자동 인계 토글, 서브에이전트 독립 한도. 맨 아래 한 줄 슬래시 명령: `/ctx-pause` 개입 일시 중지 · `/ctx-resume` 재개 · `/ctx-handover` 즉시 백업 후 인계(세션을 유휴 경계로 유도하고 컴팩션 재시도 창을 기다리므로 결과까지 몇 분 걸릴 수 있습니다).

   ![능력 랭킹과 컨텍스트 수위](docs/assets/conf-demo3.png)

6. **검증** — 모든 세션 헤더의 프리셋 chip 옆에 ⚡ 배지가 나타납니다. 모델에게 "시스템 프롬프트 마지막 섹션에 뭐라고 쓰여 있나요?"라고 물어보세요. dsh-switchman 교리를 언급해야 합니다.

**db-query 최초 사용 초기화**(스크립트 의존성은 스킬 디렉터리 안에 설치됩니다):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## 동작 방식

- Host 쪽(`index.js` + `host/`)은 동적 시스템 프롬프트 섹션 3개, 읽기 예산과 enforce 이중 게이트, 답변 자동 캡처, 슬래시 명령 3개를 주입합니다. 모든 설정은 volatile 필드라서 저장 후 다음 프롬프트 조립부터 적용되며 재시작이 필요 없습니다.
- Client 쪽(`client.js`)은 프리셋 chip 옆의 ⚡ 배지와 설정 페이지를 렌더링합니다. 공식 settings-form 서비스를 통해 이루어집니다.
- 홈 사이드바에도 **Switchman** 항목이 추가됩니다(Skills Center 행 옆). 클릭 한 번으로 같은 설정 페이지(언어 설정, 풀과 랭킹, 수위)를 중앙 패널로 엽니다. 설정 섹션과 ⚡ 배지는 그대로 유지됩니다.
- `cordis.patch.yml` 은 출하 시 기본 프리셋의 플러그인 목록을 필드 단위로 그대로 복제하고 persona suffix 만 확장합니다. Agent Teams 도구 본체는 여전히 기본 탑재 `@deepseek-ai/dsh-experimental-agent-team-profile` 에서 옵니다.

## 유지 보수

- DSH 업그레이드 후 출하 시 기본 프리셋 플러그인 목록이 바뀌었다면, 새 `presets/*.patch.yml` 에서 `cordis.patch.yml` 을 다시 동기화하고(doctrine suffix 유지), 재설치합니다.
- 프로토콜 줄(`[SWITCHMAN:LANG|POOLS|WATERMARK]`)은 의도적으로 영어·바이트 안정을 유지합니다 — 현지화하지 마십시오.
- `npm pack --dry-run` 은 감사된 34 파일 / ~111 kB 형태를 유지해야 합니다(`docs/` 스크린샷은 패키지에 포함되지 않습니다).

## License

MIT
