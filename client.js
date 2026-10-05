/** Client half of dsh-switchman.
 *
 * One self-contained entry (the client-module system serves exactly one
 * bundle per package; sibling files cannot be synchronously required).
 *
 * Surfaces, all reading the shared "dsh-switchman" locale namespace (zh/en):
 * - Phase 0: the team-autonomy badge in `conversation.session.header.actions`,
 *   extended with the current session's actual model (provider/model@effort)
 *   for subagent sessions (live projection face, shared-snapshot fallback).
 * - Phase 1: a `settings.section` page with a "Language" card:
 *   conversation / code-comment / document language preferences.
 * - Phase 2: a "Dispatch pools & ranking" card on the same page: six lane
 *   pools and a capability ranking edited against the live model catalog
 *   (served by the Host route family), plus the enforcement mode. Every
 *   field shares one staged draft and one atomic fenced save. Selected
 *   routes outside the session's DSH-authorized child models (Host
 *   /authorized route) carry a ⚠ badge plus a one-line hint.
 * - Phase 3: a "Context watermark" card on the same page: tiered token
 *   thresholds (soft/hard/force), the per-read budget, hard-tier behavior,
 *   automatic handover, and the subagent context cap — number inputs with
 *   per-field minimum plus soft<hard<force order validation, folded into
 *   the same staged draft and one atomic save.
 * - Phase 4: an "Agent teams" card on the same page: the teams-mode master
 *   switch, the whitelist-sync sub-switch (teams mode only), and the
 *   whitelist sync status line. The ⚠ unauthorized badges and hint render
 *   only in teams mode (plain subagent dispatch names no routes).
 */

window.__ModuleLoader__.load({
	id: 'dsh-switchman',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Locale namespace shared by every dsh-switchman client surface. */
		const NS = 'dsh-switchman';

		/** Settings namespace this bundle's Host half owns (= cordis name). */
		const HOST_NS = 'dsh-switchman';

		// ------------------------------------------------------------------
		// Preference model (Phase 1 languages + Phase 2 dispatch)
		// ------------------------------------------------------------------

		/** Selectable languages. `value` is the stored settings value (BCP-style
		 * tag, ≤48 chars per the Host schema convention); `label` is the native
		 * name, identical in every UI language. */
		const LANGUAGES = [
			{ value: 'en', label: 'English' },
			{ value: 'zh-CN', label: '简体中文' },
			{ value: 'zh-TW', label: '繁體中文' },
			{ value: 'ja', label: '日本語' },
			{ value: 'ko', label: '한국어' },
			{ value: 'es', label: 'Español' },
			{ value: 'fr', label: 'Français' },
			{ value: 'de', label: 'Deutsch' },
			{ value: 'ru', label: 'Русский' },
		];

		/** Interface-language choices for this plugin's own UI: "auto"
		 * follows the DSH app language; any other value forces the plugin
		 * UI into that locale (extra locales resolve from the inline
		 * EXTRA_UI_DICTS table, falling back to English). Labels are
		 * endonyms, identical in every UI language. */
		const UI_LOCALE_OPTIONS = [
			{ value: 'auto', label: 'Auto' },
			{ value: 'en', label: 'English' },
			{ value: 'zh', label: '简体中文' },
			{ value: 'zh-TW', label: '繁體中文' },
			{ value: 'ja', label: '日本語' },
			{ value: 'ko', label: '한국어' },
			{ value: 'de', label: 'Deutsch' },
			{ value: 'es', label: 'Español' },
			{ value: 'fr', label: 'Français' },
			{ value: 'it', label: 'Italiano' },
			{ value: 'pt', label: 'Português' },
			{ value: 'ru', label: 'Русский' },
		];

		/** Repaint signal for the manual interface-locale override: t()
		 * reads an apply()-scope closure variable, so every component that
		 * renders plugin strings subscribes to this tiny store to
		 * re-render when the override changes (the DSH locale store only
		 * fires on app-language changes). Snapshot is a monotonic version
		 * counter; notify never lets one bad listener block the rest. */
		const uiLocaleListeners = new Set();
		let uiLocaleVersion = 0;
		const subscribeUiLocale = (listener) => {
			uiLocaleListeners.add(listener);
			return () => uiLocaleListeners.delete(listener);
		};
		const notifyUiLocale = () => {
			uiLocaleVersion += 1;
			for (const listener of uiLocaleListeners) {
				try {
					listener();
				} catch {
					/* one bad listener never blocks the rest */
				}
			}
		};

		/** Sentinel select value standing for a hand-typed language. */
		const CUSTOM = '__custom__';

		/** Max length of one language value (Host-side convention). */
		const LANG_MAX = 48;

		/** Host-route bridge: the restricted dynamic-module runtime has no
		 * direct network beyond same-origin fetch, so every settings
		 * read/write and the model catalog go through the Host half's
		 * /api/dsh-switchman family. Document-relative on purpose — the
		 * harness serves the GUI with <base href="./">. */
		const API_BASE = 'api/dsh-switchman/';
		async function apiRequest(resource, options) {
			try {
				const response = await fetch(`${API_BASE}${resource}`, {
					method: options?.method ?? 'GET',
					headers:
						options?.body === undefined
							? new Headers()
							: new Headers({ 'content-type': 'application/json' }),
					body: options?.body === undefined ? undefined : JSON.stringify(options.body),
				});
				let body;
				try {
					body = await response.json();
				} catch {
					body = undefined;
				}
				return response.ok
					? { ok: true, value: body }
					: { ok: false, status: response.status, value: body };
			} catch {
				return { ok: false, status: 0 };
			}
		}
		const api = {
			get: (resource) => apiRequest(resource),
			post: (resource, body) => apiRequest(resource, { method: 'POST', body }),
		};

		/** The three language fields, in display order. */
		const LANG_FIELDS = ['langConversation', 'langComments', 'langDocs'];

		/** Capability tiers, strongest first ('' = unanchored). */
		const TIERS = ['S', 'A', 'B', 'C'];

		/** Enforcement modes (dictionary keys: enforceOff/Advice/Enforce). */
		const ENFORCE_MODES = ['off', 'advice', 'enforce'];

		/** The six dispatch lanes: settings field per lane, display order.
		 *  manualField = the per-lane manual-order toggle (true = stored
		 *  array order IS the dispatch priority). */
		const POOL_FIELDS = [
			{ field: 'poolEconomy', manualField: 'poolEconomyManual', effortsField: 'poolEconomyEfforts', lane: 'economy' },
			{ field: 'poolMechanical', manualField: 'poolMechanicalManual', effortsField: 'poolMechanicalEfforts', lane: 'mechanical' },
			{ field: 'poolMain', manualField: 'poolMainManual', effortsField: 'poolMainEfforts', lane: 'main' },
			{ field: 'poolHard', manualField: 'poolHardManual', effortsField: 'poolHardEfforts', lane: 'hard' },
			{ field: 'poolVision', manualField: 'poolVisionManual', effortsField: 'poolVisionEfforts', lane: 'vision' },
			{ field: 'poolReview', manualField: 'poolReviewManual', effortsField: 'poolReviewEfforts', lane: 'review' },
		];

		/** Numeric watermark fields: settings field, schema minimum, and the
		 * Host-side default (also the fallback for malformed stored values). */
		const WM_NUMBER_FIELDS = [
			{ field: 'wmSoftTokens', min: 1000, def: 50000 },
			{ field: 'wmHardTokens', min: 2000, def: 90000 },
			{ field: 'wmForceTokens', min: 3000, def: 130000 },
			{ field: 'wmReadBudgetTokens', min: 200, def: 1500 },
			{ field: 'wmSubagentForceTokens', min: 0, def: 0 },
		];

		/** The three thresholds that must keep a strict ascending order. */
		const WM_ORDER_FIELDS = ['wmSoftTokens', 'wmHardTokens', 'wmForceTokens'];

		/** Dictionary keys per numeric watermark row. */
		const WM_ROW_KEYS = {
			wmSoftTokens: { label: 'wmSoftLabel', help: 'wmSoftHelp' },
			wmHardTokens: { label: 'wmHardLabel', help: 'wmHardHelp' },
			wmForceTokens: { label: 'wmForceLabel', help: 'wmForceHelp' },
			wmReadBudgetTokens: { label: 'wmReadBudgetLabel', help: 'wmReadBudgetHelp' },
			wmSubagentForceTokens: {
				label: 'wmSubagentForceLabel',
				help: 'wmSubagentForceHelp',
			},
		};

		/** Every settings field this page edits, in mutate order. */
		const ALL_FIELDS = [
			'uiLocale',
			...LANG_FIELDS,
			...POOL_FIELDS.map(({ field }) => field),
			...POOL_FIELDS.map(({ manualField }) => manualField),
			...POOL_FIELDS.map(({ effortsField }) => effortsField),
			'modelRank',
			'dispatchEnforce',
			...WM_NUMBER_FIELDS.map(({ field }) => field),
			'wmDenyMode',
			'wmAutoHandover',
			'wmSubagentCap',
			'teamsMode',
			'syncWhitelist',
		];

		/** Stable identity of one provider/model route. */
		const routeKey = (route) => `${route.provider}\0${route.model}`;

		/** One well-formed {provider, model} route, or null. */
		function sanitizeRoute(route) {
			if (route === null || typeof route !== 'object') return null;
			if (typeof route.provider !== 'string' || route.provider === '') return null;
			if (typeof route.model !== 'string' || route.model === '') return null;
			return { provider: route.provider, model: route.model };
		}

		/** One well-formed rank entry ({provider, model[, tier]}), or null;
		 * an unknown tier is dropped rather than the whole entry. */
		function sanitizeRankEntry(entry) {
			const route = sanitizeRoute(entry);
			if (route === null) return null;
			return typeof entry.tier === 'string' && TIERS.includes(entry.tier)
				? { ...route, tier: entry.tier }
				: route;
		}

		/** Reasoning-effort fallback tiers (used when wire metadata is
		 * unavailable for a model); the real list follows wire
		 * reasoning.efforts. */
		const EFFORTS = ['low', 'medium', 'high'];

		/** One well-formed effort entry ({provider, model, effort}), or null. */
		function sanitizeEffortEntry(entry) {
			const route = sanitizeRoute(entry);
			if (route === null) return null;
			return typeof entry.effort === 'string' && entry.effort !== ''
				? { ...route, effort: entry.effort }
				: null;
		}

		/** Is `value` one of the predefined candidates? */
		function isCandidate(value) {
			return LANGUAGES.some((language) => language.value === value);
		}

		/** Human display for a stored value: "简体中文 (zh-CN)", or the raw
		 * string when it is a custom value. */
		function formatLanguage(value) {
			if (value === '') return '';
			const known = LANGUAGES.find((language) => language.value === value);
			return known === undefined ? value : `${known.label} (${known.value})`;
		}

		/** Suggested conversation language for one UI locale id: 'zh' maps to
		 * the zh-CN candidate, a matching candidate id maps to itself, anything
		 * else falls back to English. Display-only advice — never written. */
		function suggestFromUiLocale(id) {
			if (id === 'zh') return 'zh-CN';
			return isCandidate(id) ? id : 'en';
		}

		/** Read every field this page edits off a form snapshot, coerced to
		 * shape ('' / [] / numeric / boolean / enum defaults when unset or
		 * malformed). */
		function readCurrent(snapshot) {
			// Form state carries the Host snapshot under `values` (the
			// original configForms shape used `.value`; keep a fallback so
			// a shape regression degrades instead of silently blanking).
			const value = snapshot.values ?? snapshot.value;
			const string = (field) =>
				typeof value?.[field] === 'string' ? value[field] : '';
			const routes = (field) =>
				Array.isArray(value?.[field])
					? value[field].map(sanitizeRoute).filter(Boolean)
					: [];
			const efforts = (field) =>
				Array.isArray(value?.[field])
					? value[field].map(sanitizeEffortEntry).filter(Boolean)
					: [];
			const number = ({ field, def }) =>
				typeof value?.[field] === 'number' && Number.isFinite(value[field])
					? value[field]
					: def;
			const bool = (field, def) =>
				typeof value?.[field] === 'boolean' ? value[field] : def;
			return {
				// Interface-locale enum (a missing/invalid host snapshot
				// always presents as "auto"), then the scope enum (same
				// fallback to "global"). Both sit first to mirror save()'s
				// desired object; equality itself is canonical()-based, so
				// key order is not load-bearing.
				uiLocale: UI_LOCALE_OPTIONS.some((option) => option.value === value?.uiLocale)
					? value.uiLocale
					: 'auto',
				langScope: value?.langScope === 'project' ? 'project' : 'global',
				langConversation: string('langConversation'),
				langComments: string('langComments'),
				langDocs: string('langDocs'),
				...Object.fromEntries(
					POOL_FIELDS.map(({ field }) => [field, routes(field)]),
				),
				...Object.fromEntries(
					POOL_FIELDS.map(({ field, manualField }) => [
						manualField,
						bool(manualField, false),
					]),
				),
				...Object.fromEntries(
					POOL_FIELDS.map(({ effortsField }) => [
						effortsField,
						efforts(effortsField),
					]),
				),
				modelRank: Array.isArray(value?.modelRank)
					? value.modelRank.map(sanitizeRankEntry).filter(Boolean)
					: [],
				dispatchEnforce: ENFORCE_MODES.includes(value?.dispatchEnforce)
					? value.dispatchEnforce
					: 'advice',
				...Object.fromEntries(
					WM_NUMBER_FIELDS.map((spec) => [spec.field, number(spec)]),
				),
				wmDenyMode: value?.wmDenyMode === 'deny' ? 'deny' : 'cap',
				wmAutoHandover: bool('wmAutoHandover', true),
				wmSubagentCap: bool('wmSubagentCap', true),
				teamsMode: bool('teamsMode', false),
				syncWhitelist: bool('syncWhitelist', false),
			};
		}

		/** Canonical serialization for equality: auto pools compare as sets
		 * (order irrelevant) while manual pools compare as ordered sequences
		 * (their order IS the dispatch priority), the ranking as an ordered
		 * tier-annotated sequence, everything else verbatim (numbers as
		 * numbers — never their input-string forms). */
		function canonical(values) {
			return JSON.stringify({
				langScope: values.langScope,
				langConversation: values.langConversation,
				langComments: values.langComments,
				langDocs: values.langDocs,
				uiLocale: values.uiLocale,
				...Object.fromEntries(
					POOL_FIELDS.map(({ field, manualField }) => [
						field,
						values[manualField]
							? values[field].map(routeKey)
							: values[field].map(routeKey).sort(),
					]),
				),
				...Object.fromEntries(
					POOL_FIELDS.map(({ manualField }) => [
						manualField,
						values[manualField],
					]),
				),
				...Object.fromEntries(
					POOL_FIELDS.map(({ effortsField }) => [
						effortsField,
						values[effortsField]
							.map((entry) => `${routeKey(entry)}\0${entry.effort}`)
							.sort()
							.join('|'),
					]),
				),
				modelRank: values.modelRank
					.map((entry) => `${routeKey(entry)}\0${entry.tier ?? ''}`)
					.join('|'),
				dispatchEnforce: values.dispatchEnforce,
				...Object.fromEntries(
					WM_NUMBER_FIELDS.map(({ field }) => [field, values[field]]),
				),
				wmDenyMode: values.wmDenyMode,
				wmAutoHandover: values.wmAutoHandover,
				wmSubagentCap: values.wmSubagentCap,
				teamsMode: values.teamsMode,
				syncWhitelist: values.syncWhitelist,
			});
		}

		/** Deep-enough equality across every edited field. */
		function sameValues(left, right) {
			return canonical(left) === canonical(right);
		}

		/** Index one catalog answer: route key → display metadata. Models are
		 * keyed by `id` (the sessionController wire shape: {id, name}) with
		 * the group id as provider; the flattened `model` shape is accepted
		 * too. Groups keep their wire order. */
		function indexCatalog(groups) {
			const index = new Map();
			for (const group of Array.isArray(groups) ? groups : []) {
				const providerName = group.name ?? group.id ?? '';
				for (const model of Array.isArray(group.models) ? group.models : []) {
					const provider = model.provider ?? group.id;
					const modelId = model.model ?? model.id;
					if (typeof provider !== 'string' || typeof modelId !== 'string')
						continue;
					index.set(routeKey({ provider, model: modelId }), {
						provider,
						model: modelId,
						providerName: providerName || provider,
						modelName: model.name ?? modelId,
						reasoning:
							model.reasoning !== null &&
							typeof model.reasoning === 'object'
								? model.reasoning
								: undefined,
					});
				}
			}
			return index;
		}

		/** Parse the /authorized answer (the session's DSH-authorized child
		 *  models) into { enabled, keys } — null when unknown: a failed
		 *  fetch, an unreadable service (both fields null), or a malformed
		 *  shape all degrade to "no badges, no hint". A readable-but-empty
		 *  whitelist yields keys = empty Set (every selected route drifts). */
		function parseAuthorized(value) {
			if (value === null || typeof value !== 'object') return null;
			if (value.enabled !== true && value.enabled !== false) return null;
			if (!Array.isArray(value.routes)) return null;
			const keys = new Set();
			for (const route of value.routes) {
				const clean = sanitizeRoute(route);
				if (clean !== null) keys.add(routeKey(clean));
			}
			return { enabled: value.enabled, keys };
		}

		/** Checkbox rows for one pool: every live catalog model, checked or
		 *  not, plus this pool's saved routes that left the catalog (still
		 *  removable — mirrors the shipped model-selection page). */
		function poolRows(pool, catalogIndex) {
			const selected = new Set(pool.map(routeKey));
			const rows = [];
			let providerName = null;
			for (const meta of catalogIndex.values()) {
				if (meta.providerName !== providerName) {
					providerName = meta.providerName;
					rows.push({ header: providerName });
				}
				rows.push({ ...meta, selected: selected.has(routeKey(meta)) });
			}
			const extras = pool
				.filter((route) => !catalogIndex.has(routeKey(route)))
				.map((route) => ({
					provider: route.provider,
					model: route.model,
					providerName: route.provider,
					modelName: route.model,
					available: false,
					selected: true,
				}));
			return { rows, extras };
		}

		/** The rank editor's display list: saved ranking first (stored order),
		 * then every universe member not yet ranked in catalog order with
		 * saved-unavailable last. Universe = all pool selections ∪ the saved
		 * ranking (opencode semantics the Host side consumes). */
		function rankDisplay(values, catalogIndex) {
			const ranked = values.modelRank.map((entry) => ({ ...entry }));
			const rankedKeys = new Set(ranked.map(routeKey));
			const universe = new Map();
			for (const { field } of POOL_FIELDS)
				for (const route of values[field]) universe.set(routeKey(route), route);
			for (const entry of ranked) universe.set(routeKey(entry), entry);
			const tail = [];
			for (const meta of catalogIndex.values()) {
				const key = routeKey(meta);
				if (!rankedKeys.has(key) && universe.has(key))
					tail.push({ provider: meta.provider, model: meta.model });
			}
			for (const [key, route] of universe)
				if (!rankedKeys.has(key) && !catalogIndex.has(key))
					tail.push({ provider: route.provider, model: route.model });
			return [...ranked, ...tail];
		}

		/** Serialize a display list back into the stored modelRank shape
		 * (tier omitted when unset). */
		const rankValue = (display) =>
			display.map((entry) => ({
				provider: entry.provider,
				model: entry.model,
				...(entry.tier ? { tier: entry.tier } : {}),
			}));

		// ------------------------------------------------------------------
		// Dictionaries
		// ------------------------------------------------------------------

		/** zh/en dictionaries; keys are stable, values follow the UI language. */
		const DICTS = {
			zh: {
				badge: '自主团队',
				badgeTip:
					'dsh-switchman：四个内置预设（standard / ptc / minimal / cordis）已注入自主智能体团队调度规程',
				handoverActive: '交接进行中',
				handoverPhaseBackup: '备份会话',
				handoverPhaseCompacting: '压缩上下文',
				handoverPhaseContinuation: '唤醒续接',
				handoverActiveTip:
					'Switchman 正在后台交接：fork 备份会话并压缩上下文，完成后自动继续任务；期间会话静止属正常现象。',
				visionHintNeedsPool:
					'当前模型不支持读图：请在 dsh-switchman 设置中配置「视觉池」模型，之后用 /vision 发送图片。',
				visionHintUseVision:
					'当前模型不支持读图：图片请用 /vision 发送（将自动派发视觉池读取）。',
				visionAutoConverted:
					'图片直发被拒：已自动改用 /vision 重发（由视觉池读取）。',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman 调度中心',
				settingsDescription: '配置 dsh-switchman 的各项偏好。',
				langSectionTitle: '语言偏好',
				langSectionDescription:
					'控制智能体的对话、代码注释与文档撰写语言。',
				langScopeLabel: '语言作用域',
				langScopeHelp: '选择这三项语言偏好的存放位置。',
				langScopeGlobal: '全局（本 profile）',
				langScopeProject: '按项目（.switchman/lang.json）',
				langProjectNote:
					'按项目模式：各项目读取自身的 .switchman/lang.json；首次询问的答案会写入该文件，文件不存在时每个会话都会询问。以下三项仅在全局模式生效。',
				langConversationLabel: '对话语言',
				langConversationHelp:
					'智能体回复与讨论使用的语言；未设置时会在首次使用时询问一次并记住。',
				langCommentsLabel: '代码注释语言',
				langCommentsHelp: '智能体编写代码注释使用的语言。',
				langDocsLabel: '文档语言',
				langDocsHelp: '智能体撰写文档使用的语言。',
				followConversation: '跟随对话语言',
				notSetAsk: '未设置（首次使用时询问）',
				customLanguage: '自定义…',
				customLanguagePlaceholder: '语言名称或 BCP 标签',
				customLanguageRequired: '请输入自定义语言（1–48 个字符）。',
				currentValue: '当前：{value}',
				currentValueUnset: '当前：未设置',
				suggestedValue: '建议：{value}',
				save: '保存',
				saving: '保存中…',
				discard: '放弃修改',
				saveFailed: '本部署没有接受这些值，已保留供你修改。',
				saveConflict: '设置已在其他位置更新。请放弃修改后重试。',
				formLoading: '正在加载设置…',
				formUnavailable: '该插件当前未加载，暂时无法配置。',
				formReadOnly: '本部署的设置为只读。',
				dispatchSectionTitle: '派发池与模型排序',
				dispatchSectionDescription:
					'按任务复杂度把模型分组进六个派发池，并维护能力排序；仅影响 dsh-switchman 的委派调度。',
				dispatchProgress: '已配置 {pools}/6 池 · 排名 {ranked} 项 · 模式 {mode}',
				poolEconomyTitle: '轻量池 · economy',
				poolEconomyDesc: '轻量批量与低复杂度任务',
				poolMechanicalTitle: '机械池 · mechanical',
				poolMechanicalDesc: '机械改写与模板化操作',
				poolMainTitle: '主力池 · main',
				poolMainDesc: '常规编码与日常任务',
				poolHardTitle: '高难池 · hard',
				poolHardDesc: '高难推理与大规模重构',
				poolVisionTitle: '多模态池 · vision',
				poolVisionDesc: '图像等多模态输入任务',
				poolReviewTitle: '复审池 · review',
				poolReviewDesc: '只读复审与独立验证',
				poolSelectAll: '全选',
				poolClear: '清空',
				poolEmpty: '暂无候选模型',
				poolManualLabel: '手动序',
				poolManualHelp:
					'开启后按列表顺序派发（首个即首选）；未开启按能力排序自动排。',
				poolManualSelected: '已选 · 派发优先序',
				poolManualAddable: '可添加',
				poolMoveUp: '上移',
				poolMoveDown: '下移',
				poolRemoveOne: '移除',
				poolEffortFollow: '跟随泳道',
				poolEffortLabel: '思考强度',
				poolEffortHelp:
					'手动指定该模型的思考强度，派发时优先于泳道默认',
				catalogLoading: '正在加载模型目录…',
				catalogLoadFailed: '无法加载模型目录。',
				catalogRetry: '重试',
				catalogPartial: '部分模型提供方暂时无法加载；已保存的选择仍可移除。',
				catalogEmpty: '当前没有模型提供方公布模型。',
				catalogUnavailableGroup: '已保存但当前不可用',
				catalogUnavailable: '当前不可用',
				unauthorizedBadge: '未在 DSH 设置的子智能体模型选择授权列表中',
				unauthorizedHint:
					'标有 ⚠ 的模型未在 DSH 设置 → 子智能体 → 模型选择 中授权，Agent 显式指定它们会被拒绝；去 DSH 设置授权，或让 Agent 走隐式派发。',
				rankTitle: '能力排序',
				rankDescription:
					'序号即能力序（最强在前），可为每项锚定 S/A/B/C 档。列表为六池选中 ∪ 已有排序；任意编辑都会固化当前显示顺序。',
				rankEmpty: '先在上方池中勾选模型，排序列表会自动出现。',
				rankTier: '档位',
				rankTierNone: '—',
				rankMoveUp: '上移',
				rankMoveDown: '下移',
				rankRemove: '移出排序',
				enforceLabel: '执行模式',
				enforceOff: '关闭',
				enforceAdvice: '建议',
				enforceEnforce: '强制',
				enforceHelpOff: '不向委派注入任何池子指引。',
				enforceHelpAdvice: '池子指引作为建议注入，模型可自行偏离。',
				enforceHelpEnforce: '池子指引作为硬约束注入，偏离会被拒绝。',
				wmSectionTitle: '上下文水位',
				wmSectionDescription:
					'按 token 用量分级收紧行为：建议、限读与收尾、自动交接。',
				wmSoftLabel: '建议水位（soft）',
				wmSoftHelp: '达到后出现横幅提示，并建议委派与整理上下文。',
				wmHardLabel: '硬水位（hard）',
				wmHardHelp: '达到后读取预算收紧，并建议收尾当前工作。',
				wmForceLabel: '强制水位（force）',
				wmForceHelp: '达到后建议备份并移交压缩（可设为自动）。',
				wmReadBudgetLabel: '单次读取预算',
				wmReadBudgetHelp: '每次读取的 token 预算；每轮上限为其两倍。',
				wmNumberInvalid: '请输入不小于 {min} 的整数。',
				wmOrderInvalid: '三档水位需严格递增：soft < hard < force。',
				wmDenyModeLabel: '硬档行为',
				wmDenyModeCap: '限流放行',
				wmDenyModeDeny: '直接拒绝',
				wmDenyModeHelpCap: '超出读预算的调用放行，但记录警示。',
				wmDenyModeHelpDeny: '超出读预算的调用直接拒绝。',
				wmAutoHandoverLabel: '自动交接',
				wmAutoHandoverHelp: '达到强制水位时自动备份并移交压缩，无需手动确认。',
				wmSubagentTitle: '子智能体',
				wmSubagentCapLabel: '子智能体上下文上限',
				wmSubagentCapHelp:
					'开启后子智能体可用下方独立强制阈值；关闭则完全跟随上方三档水位。',
				wmSubagentForceLabel: '子智能体强制阈值',
				wmSubagentForceHelp:
					'仅覆盖子智能体的 force 档（soft/hard 与主会话共用）；0 = 跟随上方强制水位。',
				wmSubagentFollowForce: '跟随 force 档（0）',
				wmCommands:
					'命令：/ctx-pause 暂停水位干预 · /ctx-resume 恢复干预 · /ctx-handover 立即备份并交接压缩。',
				teamsSectionTitle: '智能体团队',
				teamsSectionDescription:
					'切换派发形态：关闭为纯 subagent 派发（DSH 出厂保守团队策略接管）；开启后注入自主团队规程并启用 Agent Teams。',
				teamsModeLabel: '智能体团队模式',
				teamsModeHelp:
					'开启后注入团队规程（默认委派 + 分级验证 + 任务板纪律），并自动启用 DSH 的 Agent Teams bundle；派发池的 ⚠ 授权徽标仅在开启时显示。',
				syncWhitelistLabel: '同步子智能体模型白名单',
				syncWhitelistHelp:
					'独立开关（不依赖智能体团队模式）：把六池选中模型的并集整体写入 DSH「设置 → 子智能体 → 模型选择」的授权列表；dsh-switchman 成为唯一事实源。',
				whitelistSyncOk: '已同步 {count} 条（{time}）。',
				whitelistSyncError: '同步失败：{error}',
				whitelistSyncPending: '等待同步…',
				whitelistSyncNote: '白名单变更仅对之后新建的会话生效。',
				uiSectionTitle: '界面',
				uiSectionDescription: '本插件自身界面（徽标、面板、本设置页）的显示语言。',
				uiLocaleLabel: '界面语言',
				uiLocaleHelp: '「自动」跟随 DeepSeek Harness 应用语言；选择具体语言后，本插件界面将固定为该语言。',
				uiLocaleAuto: '自动（跟随 DSH）',
			},
			en: {
				badge: 'Team autonomy',
				badgeTip:
					'dsh-switchman: the four built-in presets (standard / ptc / minimal / cordis) carry the autonomous Agent Teams doctrine',
				handoverActive: 'Handover in progress',
				handoverPhaseBackup: 'forking backup',
				handoverPhaseCompacting: 'compacting context',
				handoverPhaseContinuation: 'waking continuation',
				handoverActiveTip:
					'Switchman is handing over in the background: forking a backup session and compacting context; the task continues automatically when done. A still session during this window is expected.',
				visionHintNeedsPool:
					'This model cannot read images: add vision-pool models in the dsh-switchman settings, then send images with /vision.',
				visionHintUseVision:
					'This model cannot read images: send them with /vision (routed to the vision pool automatically).',
				visionAutoConverted:
					'Image send was refused: automatically resubmitting via /vision (read by the vision pool).',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman',
				settingsDescription: 'Configure dsh-switchman preferences.',
				langSectionTitle: 'Language',
				langSectionDescription:
					'Controls the language of agent replies, code comments, and authored documents.',
				langScopeLabel: 'Language scope',
				langScopeHelp: 'Where these language preferences are stored.',
				langScopeGlobal: 'Global (this profile)',
				langScopeProject: 'Per project (.switchman/lang.json)',
				langProjectNote:
					'Per-project mode: every project reads its own .switchman/lang.json; first-use answers are saved there, and sessions ask until it exists. The three fields below apply only in global mode.',
				langConversationLabel: 'Conversation language',
				langConversationHelp:
					'The language agents reply and discuss in; when unset, you are asked once on first use and the choice is remembered.',
				langCommentsLabel: 'Code comment language',
				langCommentsHelp: 'The language agents write code comments in.',
				langDocsLabel: 'Document language',
				langDocsHelp: 'The language agents author documents in.',
				followConversation: 'Follow conversation language',
				notSetAsk: 'Not set (ask on first use)',
				customLanguage: 'Custom…',
				customLanguagePlaceholder: 'Language name or BCP tag',
				customLanguageRequired: 'Enter a custom language (1–48 characters).',
				currentValue: 'Current: {value}',
				currentValueUnset: 'Current: not set',
				suggestedValue: 'Suggested: {value}',
				save: 'Save',
				saving: 'Saving…',
				discard: 'Discard changes',
				saveFailed:
					'The deployment did not accept these values; they were left for you to correct.',
				saveConflict: 'Settings changed elsewhere. Discard your draft and try again.',
				formLoading: 'Loading settings…',
				formUnavailable: 'This plugin is not loaded, so it cannot be configured right now.',
				formReadOnly: 'This deployment stores settings read-only.',
				dispatchSectionTitle: 'Dispatch pools & model ranking',
				dispatchSectionDescription:
					'Group models into six dispatch pools by task complexity and maintain a capability ranking; only affects dsh-switchman delegation.',
				dispatchProgress: '{pools}/6 pools set · {ranked} ranked · mode {mode}',
				poolEconomyTitle: 'Economy',
				poolEconomyDesc: 'Lightweight batch and low-complexity tasks',
				poolMechanicalTitle: 'Mechanical',
				poolMechanicalDesc: 'Mechanical rewrites and templated operations',
				poolMainTitle: 'Main',
				poolMainDesc: 'Routine coding and everyday tasks',
				poolHardTitle: 'Hard',
				poolHardDesc: 'Hard reasoning and large-scale refactors',
				poolVisionTitle: 'Vision',
				poolVisionDesc: 'Multimodal (image) work',
				poolReviewTitle: 'Review',
				poolReviewDesc: 'Read-only review and independent verification',
				poolSelectAll: 'Select all',
				poolClear: 'Clear',
				poolEmpty: 'No candidate models',
				poolManualLabel: 'Manual order',
				poolManualHelp:
					'When on, dispatch follows the listed order (head = first choice); when off, lanes are ordered by capability automatically.',
				poolManualSelected: 'Selected · dispatch priority',
				poolManualAddable: 'Add models',
				poolMoveUp: 'Move up',
				poolMoveDown: 'Move down',
				poolRemoveOne: 'Remove',
				poolEffortFollow: 'follow lane',
				poolEffortLabel: 'effort',
				poolEffortHelp:
					"Pin this model's reasoning effort; it overrides the lane default when dispatching",
				catalogLoading: 'Loading model catalog…',
				catalogLoadFailed: 'The model catalog could not be loaded.',
				catalogRetry: 'Retry',
				catalogPartial: 'Some model providers could not be loaded; saved choices remain removable.',
				catalogEmpty: 'No model provider currently advertises a model.',
				catalogUnavailableGroup: 'Saved but currently unavailable',
				catalogUnavailable: 'currently unavailable',
				unauthorizedBadge: 'not authorized for explicit child dispatch in DSH Settings (subagents: model selection)',
				unauthorizedHint:
					'Models marked ⚠ are not authorized in DSH Settings → Subagents → model selection; agents naming them explicitly will be denied — authorize them in DSH Settings, or let agents dispatch implicitly.',
				rankTitle: 'Capability ranking',
				rankDescription:
					'Numbered strongest first; each entry may anchor an S/A/B/C tier. The list is pool selections ∪ the saved ranking; any edit persists the displayed order.',
				rankEmpty: 'Select models in the pools above; the ranking list appears automatically.',
				rankTier: 'Tier',
				rankTierNone: '—',
				rankMoveUp: 'Move up',
				rankMoveDown: 'Move down',
				rankRemove: 'Remove from ranking',
				enforceLabel: 'Enforcement',
				enforceOff: 'Off',
				enforceAdvice: 'Advice',
				enforceEnforce: 'Enforce',
				enforceHelpOff: 'No pool guidance is injected into delegation.',
				enforceHelpAdvice: 'Pool guidance is injected as advice; models may deviate.',
				enforceHelpEnforce: 'Pool guidance is injected as a hard constraint; deviations are refused.',
				wmSectionTitle: 'Context watermark',
				wmSectionDescription:
					'Tiered behavior by token usage: advice, capped reads and wrap-up, automatic handover.',
				wmSoftLabel: 'Soft watermark',
				wmSoftHelp: 'Past this, a banner appears and delegating or tidying the context is advised.',
				wmHardLabel: 'Hard watermark',
				wmHardHelp: 'Past this, the read budget tightens and wrapping up is advised.',
				wmForceLabel: 'Force watermark',
				wmForceHelp: 'Past this, back up and hand over to compaction (can be automatic).',
				wmReadBudgetLabel: 'Read budget',
				wmReadBudgetHelp: 'Token budget per read; each round caps at twice this.',
				wmNumberInvalid: 'Enter a whole number of {min} or more.',
				wmOrderInvalid: 'The three tiers must strictly ascend: soft < hard < force.',
				wmDenyModeLabel: 'Hard-tier behavior',
				wmDenyModeCap: 'Cap and warn',
				wmDenyModeDeny: 'Deny outright',
				wmDenyModeHelpCap: 'Over-budget calls pass, but a warning is recorded.',
				wmDenyModeHelpDeny: 'Over-budget calls are denied outright.',
				wmAutoHandoverLabel: 'Automatic handover',
				wmAutoHandoverHelp: 'At the force watermark, back up and hand over to compaction automatically.',
				wmSubagentTitle: 'Subagents',
				wmSubagentCapLabel: 'Subagent context cap',
				wmSubagentCapHelp:
					'Lets subagents use the dedicated force threshold below; off = fully follow the three tiers above.',
				wmSubagentForceLabel: 'Subagent force threshold',
				wmSubagentForceHelp:
					'Overrides only the subagent force tier (soft/hard are shared with the main session); 0 follows the force watermark above.',
				wmSubagentFollowForce: 'Follow the force tier (0)',
				wmCommands:
					'Commands: /ctx-pause suspends watermark actions · /ctx-resume resumes them · /ctx-handover backs up and hands over now.',
				teamsSectionTitle: 'Agent teams',
				teamsSectionDescription:
					"Switch the dispatch shape: off is plain subagent dispatch (DSH's factory conservative team policy takes over); on injects the autonomous team doctrine and enables Agent Teams.",
				teamsModeLabel: 'Agent teams mode',
				teamsModeHelp:
					'When on, the team doctrine (delegate by default + tiered verification + task-board discipline) is injected and the DSH Agent Teams bundle is enabled; the dispatch pools ⚠ authorization badges show only in this mode.',
				syncWhitelistLabel: 'Sync the subagent model whitelist',
				syncWhitelistHelp:
					'Independent switch (does not require agent teams mode): writes the union of the six pools over the DSH "Settings → Subagents → model selection" authorization list; dsh-switchman becomes the single source of truth.',
				whitelistSyncOk: 'Synced {count} entries ({time}).',
				whitelistSyncError: 'Sync failed: {error}',
				whitelistSyncPending: 'Waiting to sync…',
				whitelistSyncNote: 'Whitelist changes only affect sessions created afterwards.',
				uiSectionTitle: 'Interface',
				uiSectionDescription: "Display language for this plugin's own UI (badge, panel, this settings page).",
				uiLocaleLabel: 'Interface language',
				uiLocaleHelp: "Auto follows the DeepSeek Harness app language; picking a language forces this plugin's UI into it.",
				uiLocaleAuto: 'Auto (follow DSH)',
			},
		};

		/** Inline dictionaries for the extra interface locales (every
		 * UI_LOCALE_OPTIONS tag beyond zh/en). Inlined on purpose: the
		 * harness loads plugin client bundles as classic scripts, where
		 * ESM-only syntax (module meta context, dynamic module
		 * loading) is a parse-time SyntaxError there, and
		 * the plugin asset route serves only client*.js chunks — so an
		 * on-demand module fetch could never work. Key set mirrors the
		 * DICTS en table (verified by script at generation time). Keep in
		 * sync with UI_LOCALE_OPTIONS and the host ENUM_FIELDS. */
		const EXTRA_UI_DICTS = {
			'zh-TW': {
				badge: '自主團隊',
				badgeTip: 'dsh-switchman：四個內建預設（standard / ptc / minimal / cordis）已注入自主智能體團隊調度規程',
				handoverActive: '交接進行中',
				handoverPhaseBackup: '備份會話',
				handoverPhaseCompacting: '壓縮上下文',
				handoverPhaseContinuation: '喚醒續接',
				handoverActiveTip: 'Switchman 正在背景交接：fork 備份會話並壓縮上下文，完成後自動繼續任務；期間會話靜止屬正常現象。',
				visionHintNeedsPool: '目前模型不支援讀圖：請在 dsh-switchman 設定中配置多模態池模型，之後用 /vision 傳送圖片。',
				visionHintUseVision: '目前模型不支援讀圖：圖片請用 /vision 傳送（將自動派發多模態池讀取）。',
				visionAutoConverted: '圖片直傳被拒：已自動改用 /vision 重送（由多模態池讀取）。',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman 調度中心',
				settingsDescription: '設定 dsh-switchman 的各項偏好。',
				langSectionTitle: '語言偏好',
				langSectionDescription: '控制智能體的對話、程式碼註解與文件撰寫語言。',
				langScopeLabel: '語言作用範圍',
				langScopeHelp: '選擇這三項語言偏好的存放位置。',
				langScopeGlobal: '全域（本 profile）',
				langScopeProject: '按專案（.switchman/lang.json）',
				langProjectNote: '按專案模式：各專案讀取自身的 .switchman/lang.json；首次詢問的答案會寫入該檔案，檔案不存在時每個會話都會詢問。以下三項僅在全域模式生效。',
				langConversationLabel: '對話語言',
				langConversationHelp: '智能體回覆與討論使用的語言；未設定時會在首次使用時詢問一次並記住。',
				langCommentsLabel: '程式碼註解語言',
				langCommentsHelp: '智能體撰寫程式碼註解使用的語言。',
				langDocsLabel: '文件語言',
				langDocsHelp: '智能體撰寫文件使用的語言。',
				followConversation: '跟隨對話語言',
				notSetAsk: '未設定（首次使用時詢問）',
				customLanguage: '自訂…',
				customLanguagePlaceholder: '語言名稱或 BCP 標籤',
				customLanguageRequired: '請輸入自訂語言（1–48 個字元）。',
				currentValue: '目前：{value}',
				currentValueUnset: '目前：未設定',
				suggestedValue: '建議：{value}',
				save: '儲存',
				saving: '儲存中…',
				discard: '放棄修改',
				saveFailed: '本部署沒有接受這些值，已保留供你修改。',
				saveConflict: '設定已在其他位置更新。請放棄修改後重試。',
				formLoading: '正在載入設定…',
				formUnavailable: '該外掛目前未載入，暫時無法設定。',
				formReadOnly: '本部署的設定為唯讀。',
				dispatchSectionTitle: '派發池與模型排序',
				dispatchSectionDescription: '按任務複雜度把模型分組進六個派發池，並維護能力排序；僅影響 dsh-switchman 的委派調度。',
				dispatchProgress: '已設定 {pools}/6 池 · 已排名 {ranked} 項 · 模式 {mode}',
				poolEconomyTitle: '輕量池 · economy',
				poolEconomyDesc: '輕量批次與低複雜度任務',
				poolMechanicalTitle: '機械池 · mechanical',
				poolMechanicalDesc: '機械改寫與模板化操作',
				poolMainTitle: '主力池 · main',
				poolMainDesc: '常規編碼與日常任務',
				poolHardTitle: '高難池 · hard',
				poolHardDesc: '高難推理與大規模重構',
				poolVisionTitle: '多模態池 · vision',
				poolVisionDesc: '影像等多模態輸入任務',
				poolReviewTitle: '複審池 · review',
				poolReviewDesc: '唯讀複審與獨立驗證',
				poolSelectAll: '全選',
				poolClear: '清空',
				poolEmpty: '暫無候選模型',
				poolManualLabel: '手動序',
				poolManualHelp: '開啟後按清單順序派發（首個即首選）；未開啟按能力排序自動排。',
				poolManualSelected: '已選 · 派發優先序',
				poolManualAddable: '可新增',
				poolMoveUp: '上移',
				poolMoveDown: '下移',
				poolRemoveOne: '移除',
				poolEffortFollow: '跟隨泳道',
				poolEffortLabel: '思考強度',
				poolEffortHelp: '手動指定該模型的思考強度，派發時優先於泳道預設',
				catalogLoading: '正在載入模型目錄…',
				catalogLoadFailed: '無法載入模型目錄。',
				catalogRetry: '重試',
				catalogPartial: '部分模型提供者暫時無法載入；已儲存的選擇仍可移除。',
				catalogEmpty: '目前沒有模型提供者公布模型。',
				catalogUnavailableGroup: '已儲存但目前不可用',
				catalogUnavailable: '目前不可用',
				unauthorizedBadge: '未在 DSH 設定的子智能體模型選擇授權清單中',
				unauthorizedHint: '標有 ⚠ 的模型未在 DSH 設定 → 子智能體 → 模型選擇 中授權，Agent 明確指定它們會被拒絕；去 DSH 設定授權，或讓 Agent 走隱式派發。',
				rankTitle: '能力排序',
				rankDescription: '序號即能力序（最強在前），可為每項錨定 S/A/B/C 檔。清單為六池選中 ∪ 已有排序；任意編輯都會固化目前顯示順序。',
				rankEmpty: '先在上方池中勾選模型，排序清單會自動出現。',
				rankTier: '檔位',
				rankTierNone: '—',
				rankMoveUp: '上移',
				rankMoveDown: '下移',
				rankRemove: '移出排序',
				enforceLabel: '執行模式',
				enforceOff: '關閉',
				enforceAdvice: '建議',
				enforceEnforce: '強制',
				enforceHelpOff: '不向委派注入任何池子指引。',
				enforceHelpAdvice: '池子指引作為建議注入，模型可自行偏離。',
				enforceHelpEnforce: '池子指引作為硬性約束注入，偏離會被拒絕。',
				wmSectionTitle: '上下文水位',
				wmSectionDescription: '按 token 用量分級收緊行為：建議、限讀與收尾、自動交接。',
				wmSoftLabel: '建議水位（soft）',
				wmSoftHelp: '達到後出現橫幅提示，並建議委派與整理上下文。',
				wmHardLabel: '硬水位（hard）',
				wmHardHelp: '達到後讀取預算收緊，並建議收尾目前工作。',
				wmForceLabel: '強制水位（force）',
				wmForceHelp: '達到後建議備份並移交壓縮（可設為自動）。',
				wmReadBudgetLabel: '單次讀取預算',
				wmReadBudgetHelp: '每次讀取的 token 預算；每輪上限為其兩倍。',
				wmNumberInvalid: '請輸入不小於 {min} 的整數。',
				wmOrderInvalid: '三檔水位需嚴格遞增：soft < hard < force。',
				wmDenyModeLabel: '硬檔行為',
				wmDenyModeCap: '限流放行',
				wmDenyModeDeny: '直接拒絕',
				wmDenyModeHelpCap: '超出讀取預算的呼叫放行，但記錄警示。',
				wmDenyModeHelpDeny: '超出讀取預算的呼叫直接拒絕。',
				wmAutoHandoverLabel: '自動交接',
				wmAutoHandoverHelp: '達到強制水位時自動備份並移交壓縮，無需手動確認。',
				wmSubagentTitle: '子智能體',
				wmSubagentCapLabel: '子智能體上下文上限',
				wmSubagentCapHelp: '開啟後子智能體可用下方獨立強制閾值；關閉則完全跟隨上方三檔水位。',
				wmSubagentForceLabel: '子智能體強制閾值',
				wmSubagentForceHelp: '僅覆蓋子智能體的 force 檔（soft/hard 與主會話共用）；0 = 跟隨上方強制水位。',
				wmSubagentFollowForce: '跟隨 force 檔（0）',
				wmCommands: '命令：/ctx-pause 暫停水位干預 · /ctx-resume 恢復干預 · /ctx-handover 立即備份並交接壓縮。',
				teamsSectionTitle: '智能體團隊',
				teamsSectionDescription: '切換派發形態：關閉為純 subagent 派發（DSH 出廠保守團隊策略接管）；開啟後注入自主團隊規程並啟用 Agent Teams。',
				teamsModeLabel: '智能體團隊模式',
				teamsModeHelp: '開啟後注入團隊規程（預設委派 + 分級驗證 + 任務板紀律），並自動啟用 DSH 的 Agent Teams bundle；派發池的 ⚠ 授權徽標僅在開啟時顯示。',
				syncWhitelistLabel: '同步子智能體模型白名單',
				syncWhitelistHelp: '獨立開關（不依賴智能體團隊模式）：把六池選中模型的聯集整體寫入 DSH「設定 → 子智能體 → 模型選擇」的授權清單；dsh-switchman 成為唯一事實來源。',
				whitelistSyncOk: '已同步 {count} 條（{time}）。',
				whitelistSyncError: '同步失敗：{error}',
				whitelistSyncPending: '等待同步…',
				whitelistSyncNote: '白名單變更僅對之後新建的會話生效。',
				uiSectionTitle: '介面',
				uiSectionDescription: '本外掛自身 UI（徽章、面板、此設定頁）的顯示語言。',
				uiLocaleLabel: '介面語言',
				uiLocaleHelp: '「自動」跟隨 DeepSeek Harness 應用程式語言；指定語言後，本外掛的 UI 固定使用該語言。',
				uiLocaleAuto: '自動（跟隨 DSH）',
			},
			ja: {
				badge: '自律チーム',
				badgeTip: 'dsh-switchman：内蔵の 4 プリセット（standard / ptc / minimal / cordis）には自律エージェントチームのディスパッチ規律が注入済み',
				handoverActive: 'ハンドオーバー進行中',
				handoverPhaseBackup: 'バックアップ作成中',
				handoverPhaseCompacting: 'コンテキスト圧縮中',
				handoverPhaseContinuation: '継続セッション起動中',
				handoverActiveTip: 'Switchman がバックグラウンドでハンドオーバー中です：セッションを fork してバックアップし、コンテキストを圧縮します。完了するとタスクは自動的に再開します。この間セッションが静止するのは正常です。',
				visionHintNeedsPool: 'このモデルは画像を読めません：dsh-switchman の設定でマルチモーダルプールのモデルを追加し、画像は /vision で送信してください。',
				visionHintUseVision: 'このモデルは画像を読めません：画像は /vision で送ってください（自動的にマルチモーダルプールへルーティングされます）。',
				visionAutoConverted: '画像の直接送信は拒否されました：自動的に /vision で再送信します（マルチモーダルプールが読み取ります）。',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman ディスパッチセンター',
				settingsDescription: 'dsh-switchman の各種設定を行います。',
				langSectionTitle: '言語設定',
				langSectionDescription: 'エージェントの返信・コードコメント・ドキュメントの言語を制御します。',
				langScopeLabel: '言語スコープ',
				langScopeHelp: 'これらの言語設定の保存先です。',
				langScopeGlobal: 'グローバル（このプロファイル）',
				langScopeProject: 'プロジェクト単位（.switchman/lang.json）',
				langProjectNote: 'プロジェクトモード：各プロジェクトは自身の .switchman/lang.json を読み取ります。初回の回答はそこに保存され、ファイルが存在するまで毎セッション尋ねます。下の 3 項目はグローバルモードでのみ有効です。',
				langConversationLabel: '会話言語',
				langConversationHelp: 'エージェントが返信や議論に使う言語です。未設定の場合、最初の使用時に一度だけ尋ねて記憶されます。',
				langCommentsLabel: 'コードコメント言語',
				langCommentsHelp: 'エージェントがコードコメントを書く言語です。',
				langDocsLabel: 'ドキュメント言語',
				langDocsHelp: 'エージェントがドキュメントを書く言語です。',
				followConversation: '会話言語に従う',
				notSetAsk: '未設定（初回使用時に尋ねる）',
				customLanguage: 'カスタム…',
				customLanguagePlaceholder: '言語名または BCP タグ',
				customLanguageRequired: 'カスタム言語を入力してください（1–48 文字）。',
				currentValue: '現在：{value}',
				currentValueUnset: '現在：未設定',
				suggestedValue: '推奨：{value}',
				save: '保存',
				saving: '保存中…',
				discard: '変更を破棄',
				saveFailed: 'このデプロイメントはこれらの値を受け付けませんでした。修正できるよう残してあります。',
				saveConflict: '設定が別の場所で変更されました。下書きを破棄してもう一度お試しください。',
				formLoading: '設定を読み込み中…',
				formUnavailable: 'このプラグインは現在ロードされていないため、設定できません。',
				formReadOnly: 'このデプロイメントの設定は読み取り専用です。',
				dispatchSectionTitle: 'ディスパッチプールとモデル順位',
				dispatchSectionDescription: 'タスクの複雑さに応じてモデルを 6 つのディスパッチプールに分け、能力順位を管理します。dsh-switchman の委譲にのみ影響します。',
				dispatchProgress: '{pools}/6 プール設定 · {ranked} 件ランク済み · モード {mode}',
				poolEconomyTitle: '軽量 · economy',
				poolEconomyDesc: '小口のバッチと低複雑度タスク',
				poolMechanicalTitle: '機械的 · mechanical',
				poolMechanicalDesc: '機械的な書き換えとテンプレート操作',
				poolMainTitle: '主力 · main',
				poolMainDesc: '日常的なコーディングと定常タスク',
				poolHardTitle: '高難度 · hard',
				poolHardDesc: '難しい推論と大規模リファクタリング',
				poolVisionTitle: 'マルチモーダル · vision',
				poolVisionDesc: '画像などのマルチモーダル作業',
				poolReviewTitle: 'レビュー · review',
				poolReviewDesc: '読み取り専用レビューと独立検証',
				poolSelectAll: 'すべて選択',
				poolClear: 'クリア',
				poolEmpty: '候補モデルなし',
				poolManualLabel: '手動順序',
				poolManualHelp: 'オンにするとリストの順序でディスパッチします（先頭＝第一候補）。オフなら能力順で自動的に並びます。',
				poolManualSelected: '選択済み · ディスパッチ優先順',
				poolManualAddable: 'モデルを追加',
				poolMoveUp: '上へ',
				poolMoveDown: '下へ',
				poolRemoveOne: '削除',
				poolEffortFollow: 'レーンに従う',
				poolEffortLabel: '思考強度',
				poolEffortHelp: 'このモデルの思考強度を固定します。ディスパッチ時にレーンのデフォルトより優先されます',
				catalogLoading: 'モデルカタログを読み込み中…',
				catalogLoadFailed: 'モデルカタログを読み込めませんでした。',
				catalogRetry: '再試行',
				catalogPartial: '一部のモデルプロバイダーを読み込めませんでした。保存済みの選択は引き続き削除できます。',
				catalogEmpty: '現在モデルを公開しているプロバイダーはありません。',
				catalogUnavailableGroup: '保存済みだが現在利用不可',
				catalogUnavailable: '現在利用不可',
				unauthorizedBadge: 'DSH 設定のサブエージェント・モデル選択の許可リストに含まれていません',
				unauthorizedHint: '⚠ マークのモデルは DSH 設定 → サブエージェント → モデル選択 で許可されていません。エージェントが明示的に指定すると拒否されます。DSH 設定で許可するか、暗黙のディスパッチを利用してください。',
				rankTitle: '能力順位',
				rankDescription: '番号は能力順（最強が先頭）で、各項目に S/A/B/C ティアを設定できます。リストはプール選択 ∪ 保存済み順位です。編集すると表示中の順序がそのまま保存されます。',
				rankEmpty: '上のプールでモデルを選択すると、順位リストが自動的に表示されます。',
				rankTier: 'ティア',
				rankTierNone: '—',
				rankMoveUp: '上へ',
				rankMoveDown: '下へ',
				rankRemove: '順位から削除',
				enforceLabel: '強制モード',
				enforceOff: 'オフ',
				enforceAdvice: 'アドバイス',
				enforceEnforce: '強制',
				enforceHelpOff: '委譲にプールのガイダンスを注入しません。',
				enforceHelpAdvice: 'プールのガイダンスをアドバイスとして注入します。モデルは外れることができます。',
				enforceHelpEnforce: 'プールのガイダンスを厳格な制約として注入します。外れた場合は拒否されます。',
				wmSectionTitle: 'コンテキスト水位',
				wmSectionDescription: 'token 使用量に応じた段階的な引き締め：アドバイス、読み取り制限と締めくくり、自動ハンドオーバー。',
				wmSoftLabel: 'ソフト水位（soft）',
				wmSoftHelp: '超えるとバナーが表示され、委譲やコンテキスト整理が推奨されます。',
				wmHardLabel: 'ハード水位（hard）',
				wmHardHelp: '超えると読み取り予算が引き締められ、仕事の締めくくりが推奨されます。',
				wmForceLabel: '強制水位（force）',
				wmForceHelp: '超えるとバックアップと圧縮へのハンドオーバーが推奨されます（自動化可能）。',
				wmReadBudgetLabel: '読み取り予算',
				wmReadBudgetHelp: '1 回の読み取りあたりの token 予算です。各ラウンドの上限はその 2 倍です。',
				wmNumberInvalid: '{min} 以上の整数を入力してください。',
				wmOrderInvalid: '3 段階の水位は厳密に昇順にしてください：soft < hard < force。',
				wmDenyModeLabel: 'ハード段階の動作',
				wmDenyModeCap: '制限して警告',
				wmDenyModeDeny: '即時拒否',
				wmDenyModeHelpCap: '予算超過の呼び出しは通しますが、警告を記録します。',
				wmDenyModeHelpDeny: '予算超過の呼び出しは即座に拒否します。',
				wmAutoHandoverLabel: '自動ハンドオーバー',
				wmAutoHandoverHelp: '強制水位に達したら、確認なしでバックアップして圧縮へハンドオーバーします。',
				wmSubagentTitle: 'サブエージェント',
				wmSubagentCapLabel: 'サブエージェントのコンテキスト上限',
				wmSubagentCapHelp: 'オンにすると、下の専用強制しきい値を使えます。オフなら上の 3 段階の水位に完全に従います。',
				wmSubagentForceLabel: 'サブエージェント強制しきい値',
				wmSubagentForceHelp: 'サブエージェントの force 段階のみを上書きします（soft/hard はメインセッションと共通）。0 なら上の強制水位に従います。',
				wmSubagentFollowForce: 'force 段階に従う（0）',
				wmCommands: 'コマンド：/ctx-pause で水位アクションを一時停止 · /ctx-resume で再開 · /ctx-handover で今すぐバックアップしてハンドオーバー。',
				teamsSectionTitle: 'エージェントチーム',
				teamsSectionDescription: 'ディスパッチ形態の切り替え：オフは通常の subagent ディスパッチ（DSH 出荷時の保守的なチームポリシーが引き継ぎ）。オンにすると自律チーム規律を注入し、Agent Teams を有効にします。',
				teamsModeLabel: 'エージェントチームモード',
				teamsModeHelp: 'オンにするとチーム規律（デフォルト委譲 + 段階的検証 + タスクボードの規律）を注入し、DSH の Agent Teams バンドルを有効にします。ディスパッチプールの ⚠ 許可バッジはこのモードでのみ表示されます。',
				syncWhitelistLabel: 'サブエージェントモデル許可リストの同期',
				syncWhitelistHelp: '独立したスイッチです（エージェントチームモード不要）：6 プールで選択されたモデルの和集合を、DSH の「設定 → サブエージェント → モデル選択」許可リストにまるごと書き込みます。dsh-switchman が唯一の事実源になります。',
				whitelistSyncOk: '{count} 件を同期しました（{time}）。',
				whitelistSyncError: '同期に失敗しました：{error}',
				whitelistSyncPending: '同期待ち…',
				whitelistSyncNote: '許可リストの変更は、以降に新しく作成されたセッションにのみ反映されます。',
				uiSectionTitle: 'インターフェース',
				uiSectionDescription: 'このプラグイン自身の UI（バッジ、パネル、この設定ページ）の表示言語です。',
				uiLocaleLabel: 'インターフェース言語',
				uiLocaleHelp: '「自動」は DeepSeek Harness アプリの言語に従います。言語を選ぶと、このプラグインの UI がその言語に固定されます。',
				uiLocaleAuto: '自動（DSH に従う）',
			},
			ko: {
				badge: '자율 팀',
				badgeTip: 'dsh-switchman: 네 가지 내장 프리셋(standard / ptc / minimal / cordis)에 자율 에이전트 팀 디스패치 규율이 주입되어 있습니다',
				handoverActive: '핸드오버 진행 중',
				handoverPhaseBackup: '세션 백업 중',
				handoverPhaseCompacting: '컨텍스트 압축 중',
				handoverPhaseContinuation: '후속 세션 깨우는 중',
				handoverActiveTip: 'Switchman이 백그라운드에서 핸드오버 중입니다: 세션을 fork해 백업하고 컨텍스트를 압축하며, 완료되면 작업이 자동으로 이어집니다. 이 동안 세션이 잠시 멈추는 것은 정상입니다.',
				visionHintNeedsPool: '이 모델은 이미지를 읽을 수 없습니다: dsh-switchman 설정에서 멀티모달 풀 모델을 추가한 뒤, 이미지를 /vision으로 보내 주세요.',
				visionHintUseVision: '이 모델은 이미지를 읽을 수 없습니다: 이미지는 /vision으로 보내 주세요(자동으로 멀티모달 풀로 라우팅됩니다).',
				visionAutoConverted: '이미지 직접 전송이 거부되었습니다: 자동으로 /vision으로 다시 보냅니다(멀티모달 풀이 읽습니다).',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman 디스패치 센터',
				settingsDescription: 'dsh-switchman 기본 설정을 구성합니다.',
				langSectionTitle: '언어',
				langSectionDescription: '에이전트 응답, 코드 주석, 작성 문서의 언어를 제어합니다.',
				langScopeLabel: '언어 범위',
				langScopeHelp: '이 언어 기본 설정의 저장 위치입니다.',
				langScopeGlobal: '전역(이 프로필)',
				langScopeProject: '프로젝트별(.switchman/lang.json)',
				langProjectNote: '프로젝트 모드: 각 프로젝트는 자신의 .switchman/lang.json을 읽습니다. 최초 응답 내용이 그 파일에 저장되며, 파일이 생길 때까지 매 세션마다 묻습니다. 아래 세 항목은 전역 모드에서만 적용됩니다.',
				langConversationLabel: '대화 언어',
				langConversationHelp: '에이전트가 응답과 토론에 사용하는 언어입니다. 설정하지 않으면 처음 사용할 때 한 번만 묻고 기억합니다.',
				langCommentsLabel: '코드 주석 언어',
				langCommentsHelp: '에이전트가 코드 주석을 작성하는 언어입니다.',
				langDocsLabel: '문서 언어',
				langDocsHelp: '에이전트가 문서를 작성하는 언어입니다.',
				followConversation: '대화 언어 따르기',
				notSetAsk: '미설정(처음 사용 시 묻기)',
				customLanguage: '사용자 지정…',
				customLanguagePlaceholder: '언어 이름 또는 BCP 태그',
				customLanguageRequired: '사용자 지정 언어를 입력하세요(1–48자).',
				currentValue: '현재: {value}',
				currentValueUnset: '현재: 미설정',
				suggestedValue: '추천: {value}',
				save: '저장',
				saving: '저장 중…',
				discard: '변경 취소',
				saveFailed: '이 배포에서 해당 값을 수락하지 않아, 수정할 수 있도록 남겨 두었습니다.',
				saveConflict: '다른 곳에서 설정이 변경되었습니다. 초안을 버리고 다시 시도하세요.',
				formLoading: '설정 불러오는 중…',
				formUnavailable: '이 플러그인이 로드되어 있지 않아 지금은 설정할 수 없습니다.',
				formReadOnly: '이 배포의 설정은 읽기 전용입니다.',
				dispatchSectionTitle: '디스패치 풀과 모델 순위',
				dispatchSectionDescription: '작업 복잡도에 따라 모델을 여섯 개 디스패치 풀로 묶고 능력 순위를 유지합니다. dsh-switchman 위임에만 영향을 줍니다.',
				dispatchProgress: '{pools}/6개 풀 설정 · {ranked}개 순위 지정 · 모드 {mode}',
				poolEconomyTitle: '경량 · economy',
				poolEconomyDesc: '가벼운 일괄 작업과 낮은 복잡도 작업',
				poolMechanicalTitle: '기계 · mechanical',
				poolMechanicalDesc: '기계적 재작성과 템플릿 작업',
				poolMainTitle: '주력 · main',
				poolMainDesc: '일상적 코딩과 매일 하는 작업',
				poolHardTitle: '고난도 · hard',
				poolHardDesc: '어려운 추론과 대규모 리팩터링',
				poolVisionTitle: '멀티모달 · vision',
				poolVisionDesc: '이미지 등 멀티모달 작업',
				poolReviewTitle: '리뷰 · review',
				poolReviewDesc: '읽기 전용 리뷰와 독립 검증',
				poolSelectAll: '모두 선택',
				poolClear: '지우기',
				poolEmpty: '후보 모델 없음',
				poolManualLabel: '수동 순서',
				poolManualHelp: '켜면 목록 순서대로 디스패치합니다(맨 앞이 제1순위). 끄면 능력 순으로 자동 정렬됩니다.',
				poolManualSelected: '선택됨 · 디스패치 우선순위',
				poolManualAddable: '모델 추가',
				poolMoveUp: '위로',
				poolMoveDown: '아래로',
				poolRemoveOne: '제거',
				poolEffortFollow: '레인 따르기',
				poolEffortLabel: '추론 강도',
				poolEffortHelp: '이 모델의 추론 강도를 고정합니다. 디스패치 시 레인 기본값보다 우선합니다',
				catalogLoading: '모델 카탈로그 불러오는 중…',
				catalogLoadFailed: '모델 카탈로그를 불러올 수 없습니다.',
				catalogRetry: '다시 시도',
				catalogPartial: '일부 모델 공급자를 불러오지 못했습니다. 저장된 선택 항목은 여전히 제거할 수 있습니다.',
				catalogEmpty: '현재 모델을 공개하는 공급자가 없습니다.',
				catalogUnavailableGroup: '저장되었으나 현재 사용 불가',
				catalogUnavailable: '현재 사용 불가',
				unauthorizedBadge: 'DSH 설정의 서브에이전트 모델 선택 허용 목록에 없음',
				unauthorizedHint: '⚠ 표시가 붙은 모델은 DSH 설정 → 서브에이전트 → 모델 선택에서 허용되지 않았습니다. 에이전트가 명시적으로 지정하면 거부됩니다. DSH 설정에서 허용하거나, 암시적 디스패치를 이용하세요.',
				rankTitle: '능력 순위',
				rankDescription: '번호가 능력 순서입니다(가장 강한 것이 앞). 각 항목에 S/A/B/C 티어를 지정할 수 있습니다. 목록은 풀 선택 ∪ 저장된 순위이며, 편집하면 표시된 순서가 그대로 저장됩니다.',
				rankEmpty: '위 풀에서 모델을 선택하면 순위 목록이 자동으로 나타납니다.',
				rankTier: '티어',
				rankTierNone: '—',
				rankMoveUp: '위로',
				rankMoveDown: '아래로',
				rankRemove: '순위에서 제거',
				enforceLabel: '적용 모드',
				enforceOff: '끄기',
				enforceAdvice: '조언',
				enforceEnforce: '강제',
				enforceHelpOff: '위임에 풀 지침을 주입하지 않습니다.',
				enforceHelpAdvice: '풀 지침을 조언으로 주입합니다. 모델이 벗어날 수 있습니다.',
				enforceHelpEnforce: '풀 지침을 엄격한 제약으로 주입합니다. 벗어나면 거부됩니다.',
				wmSectionTitle: '컨텍스트 수위',
				wmSectionDescription: '토큰 사용량에 따른 단계별 강화: 조언, 읽기 제한과 마무리, 자동 핸드오버.',
				wmSoftLabel: '소프트 수위(soft)',
				wmSoftHelp: '넘으면 배너가 나타나고 위임이나 컨텍스트 정리를 권장합니다.',
				wmHardLabel: '하드 수위(hard)',
				wmHardHelp: '넘으면 읽기 예산이 줄어들고 작업 마무리를 권장합니다.',
				wmForceLabel: '강제 수위(force)',
				wmForceHelp: '넘으면 백업 후 압축으로 핸드오버를 권장합니다(자동화 가능).',
				wmReadBudgetLabel: '읽기 예산',
				wmReadBudgetHelp: '한 번 읽기당 토큰 예산입니다. 매 라운드 상한은 그 두 배입니다.',
				wmNumberInvalid: '{min} 이상의 정수를 입력하세요.',
				wmOrderInvalid: '세 수위는 엄격히 증가해야 합니다: soft < hard < force.',
				wmDenyModeLabel: '하드 단계 동작',
				wmDenyModeCap: '제한하고 경고',
				wmDenyModeDeny: '즉시 거부',
				wmDenyModeHelpCap: '예산 초과 호출은 통과시키지만 경고를 기록합니다.',
				wmDenyModeHelpDeny: '예산 초과 호출은 즉시 거부합니다.',
				wmAutoHandoverLabel: '자동 핸드오버',
				wmAutoHandoverHelp: '강제 수위에 도달하면 확인 없이 백업하고 압축으로 핸드오버합니다.',
				wmSubagentTitle: '서브에이전트',
				wmSubagentCapLabel: '서브에이전트 컨텍스트 상한',
				wmSubagentCapHelp: '켜면 서브에이전트가 아래 전용 강제 임계값을 사용합니다. 끄면 위 세 수위를 그대로 따릅니다.',
				wmSubagentForceLabel: '서브에이전트 강제 임계값',
				wmSubagentForceHelp: '서브에이전트의 force 단계만 덮어씁니다(soft/hard는 메인 세션과 공유). 0이면 위 강제 수위를 따릅니다.',
				wmSubagentFollowForce: 'force 단계 따르기(0)',
				wmCommands: '명령: /ctx-pause 수위 개입 일시 중지 · /ctx-resume 재개 · /ctx-handover 지금 백업하고 핸드오버.',
				teamsSectionTitle: '에이전트 팀',
				teamsSectionDescription: '디스패치 형태 전환: 끄면 일반 subagent 디스패치입니다(DSH 출고 기본 보수적 팀 정책이 이어받음). 켜면 자율 팀 규율을 주입하고 Agent Teams를 활성화합니다.',
				teamsModeLabel: '에이전트 팀 모드',
				teamsModeHelp: '켜면 팀 규율(기본 위임 + 단계별 검증 + 작업판 규율)을 주입하고 DSH의 Agent Teams 번들을 활성화합니다. 디스패치 풀의 ⚠ 허용 배지는 이 모드에서만 표시됩니다.',
				syncWhitelistLabel: '서브에이전트 모델 허용 목록 동기화',
				syncWhitelistHelp: '독립 스위치입니다(에이전트 팀 모드 불필요): 여섯 풀에서 선택한 모델의 합집합을 DSH 설정 → 서브에이전트 → 모델 선택 허용 목록에 통째로 씁니다. dsh-switchman이 유일한 사실 원천이 됩니다.',
				whitelistSyncOk: '{count}건 동기화됨({time}).',
				whitelistSyncError: '동기화 실패: {error}',
				whitelistSyncPending: '동기화 대기 중…',
				whitelistSyncNote: '허용 목록 변경은 이후 새로 만든 세션에만 적용됩니다.',
				uiSectionTitle: '인터페이스',
				uiSectionDescription: '이 플러그인 자체 UI(배지, 패널, 이 설정 페이지)의 표시 언어입니다.',
				uiLocaleLabel: '인터페이스 언어',
				uiLocaleHelp: '자동은 DeepSeek Harness 앱 언어를 따르고, 언어를 직접 고르면 이 플러그인의 UI가 그 언어로 고정됩니다.',
				uiLocaleAuto: '자동(DSH 따르기)',
			},
			de: {
				badge: 'Autonomes Team',
				badgeTip: 'dsh-switchman: Die vier integrierten Presets (standard / ptc / minimal / cordis) tragen die autonome-Agent-Teams-Doktrin',
				handoverActive: 'Übergabe läuft',
				handoverPhaseBackup: 'Backup wird erstellt',
				handoverPhaseCompacting: 'Kontext wird komprimiert',
				handoverPhaseContinuation: 'Fortsetzung wird geweckt',
				handoverActiveTip: 'Switchman übergibt gerade im Hintergrund: Eine Backup-Session wird geforkt und der Kontext komprimiert; die Aufgabe läuft danach automatisch weiter. Eine ruhende Session ist in dieser Phase normal.',
				visionHintNeedsPool: 'Dieses Modell kann keine Bilder lesen: Fügen Sie in den dsh-switchman-Einstellungen Modelle zum Vision-Pool hinzu und senden Sie Bilder dann mit /vision.',
				visionHintUseVision: 'Dieses Modell kann keine Bilder lesen: Senden Sie Bilder mit /vision (automatisch an den Vision-Pool geleitet).',
				visionAutoConverted: 'Direkter Bildversand wurde abgelehnt: Er wird automatisch über /vision erneut gesendet (vom Vision-Pool gelesen).',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman',
				settingsDescription: 'dsh-switchman-Einstellungen konfigurieren.',
				langSectionTitle: 'Sprache',
				langSectionDescription: 'Steuert die Sprache von Agent-Antworten, Code-Kommentaren und erstellten Dokumenten.',
				langScopeLabel: 'Sprach-Geltungsbereich',
				langScopeHelp: 'Wo diese Spracheinstellungen gespeichert werden.',
				langScopeGlobal: 'Global (dieses Profil)',
				langScopeProject: 'Pro Projekt (.switchman/lang.json)',
				langProjectNote: 'Projektmodus: Jedes Projekt liest seine eigene .switchman/lang.json; Antworten bei der Erstanwendung werden dort gespeichert, und Sessions fragen nach, bis die Datei existiert. Die drei Felder unten gelten nur im globalen Modus.',
				langConversationLabel: 'Konversationssprache',
				langConversationHelp: 'Die Sprache, in der Agenten antworten und diskutieren; ohne Festlegung werden Sie bei der ersten Nutzung einmalig gefragt, und die Auswahl wird gemerkt.',
				langCommentsLabel: 'Sprache für Code-Kommentare',
				langCommentsHelp: 'Die Sprache, in der Agenten Code-Kommentare schreiben.',
				langDocsLabel: 'Dokumentsprache',
				langDocsHelp: 'Die Sprache, in der Agenten Dokumente verfassen.',
				followConversation: 'Konversationssprache folgen',
				notSetAsk: 'Nicht gesetzt (bei Erstanwendung fragen)',
				customLanguage: 'Benutzerdefiniert…',
				customLanguagePlaceholder: 'Sprachname oder BCP-Tag',
				customLanguageRequired: 'Geben Sie eine eigene Sprache ein (1–48 Zeichen).',
				currentValue: 'Aktuell: {value}',
				currentValueUnset: 'Aktuell: nicht gesetzt',
				suggestedValue: 'Vorschlag: {value}',
				save: 'Speichern',
				saving: 'Speichern…',
				discard: 'Änderungen verwerfen',
				saveFailed: 'Diese Werte wurden von der Bereitstellung nicht akzeptiert; sie bleiben zur Korrektur erhalten.',
				saveConflict: 'Einstellungen wurden andernorts geändert. Verwerfen Sie Ihren Entwurf und versuchen Sie es erneut.',
				formLoading: 'Einstellungen werden geladen…',
				formUnavailable: 'Dieses Plugin ist nicht geladen und kann daher gerade nicht konfiguriert werden.',
				formReadOnly: 'Diese Bereitstellung speichert Einstellungen schreibgeschützt.',
				dispatchSectionTitle: 'Dispatch-Pools und Modell-Ranking',
				dispatchSectionDescription: 'Gruppiert Modelle nach Aufgabenkomplexität in sechs Dispatch-Pools und pflegt ein Fähigkeits-Ranking; betrifft nur die Delegation von dsh-switchman.',
				dispatchProgress: '{pools}/6 Pools gesetzt · {ranked} im Ranking · Modus {mode}',
				poolEconomyTitle: 'Leicht · economy',
				poolEconomyDesc: 'Leichte Massen- und geringkomplexe Aufgaben',
				poolMechanicalTitle: 'Mechanisch · mechanical',
				poolMechanicalDesc: 'Mechanische Umschreibungen und Vorlagen-Operationen',
				poolMainTitle: 'Standard · main',
				poolMainDesc: 'Routiniertes Codieren und Alltagsaufgaben',
				poolHardTitle: 'Schwer · hard',
				poolHardDesc: 'Schweres Reasoning und große Refactorings',
				poolVisionTitle: 'Multimodal · vision',
				poolVisionDesc: 'Multimodale (Bild-)Arbeit',
				poolReviewTitle: 'Review · review',
				poolReviewDesc: 'Nur-Lese-Review und unabhängige Prüfung',
				poolSelectAll: 'Alle auswählen',
				poolClear: 'Leeren',
				poolEmpty: 'Keine Kandidatenmodelle',
				poolManualLabel: 'Manuelle Reihenfolge',
				poolManualHelp: 'Ein: Der Versand folgt der gelisteten Reihenfolge (oben = erste Wahl); aus: Lanes werden automatisch nach Fähigkeit sortiert.',
				poolManualSelected: 'Ausgewählt · Dispatch-Priorität',
				poolManualAddable: 'Modelle hinzufügen',
				poolMoveUp: 'Nach oben',
				poolMoveDown: 'Nach unten',
				poolRemoveOne: 'Entfernen',
				poolEffortFollow: 'Lane folgen',
				poolEffortLabel: 'Aufwand',
				poolEffortHelp: 'Fixiert den Reasoning-Aufwand dieses Modells; überschreibt beim Dispatch den Lane-Standard',
				catalogLoading: 'Modellkatalog wird geladen…',
				catalogLoadFailed: 'Der Modellkatalog konnte nicht geladen werden.',
				catalogRetry: 'Erneut versuchen',
				catalogPartial: 'Einige Modell-Provider konnten nicht geladen werden; gespeicherte Auswahl bleibt entfernbar.',
				catalogEmpty: 'Aktuell bewirbt kein Modell-Provider ein Modell.',
				catalogUnavailableGroup: 'Gespeichert, aber derzeit nicht verfügbar',
				catalogUnavailable: 'derzeit nicht verfügbar',
				unauthorizedBadge: 'für expliziten Subagent-Dispatch in DSH-Einstellungen (Subagents: Modellauswahl) nicht autorisiert',
				unauthorizedHint: 'Mit ⚠ markierte Modelle sind in DSH-Einstellungen → Subagents → Modellauswahl nicht autorisiert; Agenten, die sie explizit nennen, werden abgelehnt — autorisieren Sie sie in den DSH-Einstellungen oder lassen Sie Agenten implizit delegieren.',
				rankTitle: 'Fähigkeits-Ranking',
				rankDescription: 'Nummeriert, stärkstes zuerst; jeder Eintrag kann ein S/A/B/C-Tier verankern. Die Liste ist Pool-Auswahl ∪ gespeichertes Ranking; jede Änderung speichert die angezeigte Reihenfolge.',
				rankEmpty: 'Wählen Sie oben Modelle in den Pools; die Ranking-Liste erscheint automatisch.',
				rankTier: 'Tier',
				rankTierNone: '—',
				rankMoveUp: 'Nach oben',
				rankMoveDown: 'Nach unten',
				rankRemove: 'Aus dem Ranking entfernen',
				enforceLabel: 'Durchsetzung',
				enforceOff: 'Aus',
				enforceAdvice: 'Empfehlung',
				enforceEnforce: 'Erzwungen',
				enforceHelpOff: 'Es wird keine Pool-Leitlinie in Delegationen eingespeist.',
				enforceHelpAdvice: 'Pool-Leitlinien werden als Empfehlung eingespeist; Modelle dürfen abweichen.',
				enforceHelpEnforce: 'Pool-Leitlinien werden als harte Einschränkung eingespeist; Abweichungen werden abgelehnt.',
				wmSectionTitle: 'Kontext-Wasserstand',
				wmSectionDescription: 'Abgestuftes Verhalten nach Token-Nutzung: Empfehlung, gedeckelte Lesevorgänge und Abschluss, automatische Übergabe.',
				wmSoftLabel: 'Weicher Wasserstand (soft)',
				wmSoftHelp: 'Danach erscheint ein Banner, und Delegieren bzw. Kontext aufräumen wird empfohlen.',
				wmHardLabel: 'Harter Wasserstand (hard)',
				wmHardHelp: 'Danach strafft sich das Lese-Budget, und ein Abschluss wird empfohlen.',
				wmForceLabel: 'Erzwungener Wasserstand (force)',
				wmForceHelp: 'Danach Backup erstellen und an die Komprimierung übergeben (automatisch möglich).',
				wmReadBudgetLabel: 'Lese-Budget',
				wmReadBudgetHelp: 'Token-Budget pro Lesevorgang; jede Runde ist auf das Doppelte gedeckelt.',
				wmNumberInvalid: 'Geben Sie eine ganze Zahl von mindestens {min} ein.',
				wmOrderInvalid: 'Die drei Stufen müssen strikt aufsteigen: soft < hard < force.',
				wmDenyModeLabel: 'Verhalten der Hard-Stufe',
				wmDenyModeCap: 'Deckeln und warnen',
				wmDenyModeDeny: 'Direkt ablehnen',
				wmDenyModeHelpCap: 'Über-Budget-Aufrufe laufen durch, aber eine Warnung wird protokolliert.',
				wmDenyModeHelpDeny: 'Über-Budget-Aufrufe werden direkt abgelehnt.',
				wmAutoHandoverLabel: 'Automatische Übergabe',
				wmAutoHandoverHelp: 'Beim erzwungenen Wasserstand automatisch sichern und an die Komprimierung übergeben.',
				wmSubagentTitle: 'Subagents',
				wmSubagentCapLabel: 'Kontext-Deckel für Subagents',
				wmSubagentCapHelp: 'Subagents dürfen die eigene erzwungene Schwelle unten nutzen; aus = vollständig den drei Stufen oben folgen.',
				wmSubagentForceLabel: 'Erzwungene Schwelle für Subagents',
				wmSubagentForceHelp: 'Überschreibt nur die Force-Stufe der Subagents (soft/hard teilen sich mit der Haupt-Session); 0 folgt dem erzwungenen Wasserstand oben.',
				wmSubagentFollowForce: 'Der Force-Stufe folgen (0)',
				wmCommands: 'Befehle: /ctx-pause pausiert Wasserstand-Aktionen · /ctx-resume setzt sie fort · /ctx-handover sichert jetzt und übergibt sofort.',
				teamsSectionTitle: 'Agent-Teams',
				teamsSectionDescription: 'Wechselt die Dispatch-Form: Aus ist gewöhnlicher Subagent-Versand (die konservative Werks-Teamrichtlinie von DSH greift); an speist die autonome Team-Doktrin ein und aktiviert Agent Teams.',
				teamsModeLabel: 'Agent-Teams-Modus',
				teamsModeHelp: 'Ein: Die Team-Doktrin (standardmäßig delegieren + abgestufte Prüfung + Task-Board-Disziplin) wird eingespeist und das DSH-Agent-Teams-Bundle aktiviert; die ⚠-Autorisierungs-Badges der Dispatch-Pools erscheinen nur in diesem Modus.',
				syncWhitelistLabel: 'Modell-Whitelist der Subagents synchronisieren',
				syncWhitelistHelp: 'Unabhängiger Schalter (kein Agent-Teams-Modus nötig): schreibt die Vereinigung der sechs Pools in die Autorisierungsliste von DSH „Einstellungen → Subagents → Modellauswahl“; dsh-switchman wird zur einzigen Quelle der Wahrheit.',
				whitelistSyncOk: '{count} Einträge synchronisiert ({time}).',
				whitelistSyncError: 'Synchronisierung fehlgeschlagen: {error}',
				whitelistSyncPending: 'Warte auf Synchronisierung…',
				whitelistSyncNote: 'Whitelist-Änderungen wirken sich nur auf später erstellte Sessions aus.',
				uiSectionTitle: 'Oberfläche',
				uiSectionDescription: 'Anzeigesprache der eigenen Oberfläche dieses Plugins (Badge, Panel, diese Einstellungsseite).',
				uiLocaleLabel: 'Sprache der Oberfläche',
				uiLocaleHelp: 'Auto folgt der App-Sprache von DeepSeek Harness; wählt man eine Sprache, wird die Oberfläche dieses Plugins darauf festgelegt.',
				uiLocaleAuto: 'Auto (DSH folgen)',
			},
			es: {
				badge: 'Equipo autónomo',
				badgeTip: 'dsh-switchman: los cuatro preajustes integrados (standard / ptc / minimal / cordis) incorporan la doctrina de equipos de agentes autónomos',
				handoverActive: 'Traspaso en curso',
				handoverPhaseBackup: 'creando copia de seguridad',
				handoverPhaseCompacting: 'compactando contexto',
				handoverPhaseContinuation: 'despertando continuación',
				handoverActiveTip: 'Switchman está realizando el traspaso en segundo plano: crea un fork de la sesión de respaldo y compacta el contexto; la tarea continúa automáticamente al terminar. Es normal que la sesión quede quieta durante este intervalo.',
				visionHintNeedsPool: 'Este modelo no puede leer imágenes: añade modelos del grupo de visión en los ajustes de dsh-switchman y envía las imágenes con /vision.',
				visionHintUseVision: 'Este modelo no puede leer imágenes: envíalas con /vision (se enrutan automáticamente al grupo de visión).',
				visionAutoConverted: 'El envío directo de la imagen fue rechazado: se reenvía automáticamente vía /vision (lo lee el grupo de visión).',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman',
				settingsDescription: 'Configura las preferencias de dsh-switchman.',
				langSectionTitle: 'Idioma',
				langSectionDescription: 'Controla el idioma de las respuestas de los agentes, los comentarios de código y los documentos redactados.',
				langScopeLabel: 'Ámbito del idioma',
				langScopeHelp: 'Dónde se guardan estas preferencias de idioma.',
				langScopeGlobal: 'Global (este perfil)',
				langScopeProject: 'Por proyecto (.switchman/lang.json)',
				langProjectNote: 'Modo por proyecto: cada proyecto lee su propio .switchman/lang.json; la respuesta del primer uso se guarda allí, y las sesiones preguntan hasta que exista. Los tres campos de abajo solo se aplican en modo global.',
				langConversationLabel: 'Idioma de conversación',
				langConversationHelp: 'El idioma en que los agentes responden y debaten; si no se fija, se te pregunta una vez en el primer uso y la elección se recuerda.',
				langCommentsLabel: 'Idioma de los comentarios',
				langCommentsHelp: 'El idioma en que los agentes escriben los comentarios de código.',
				langDocsLabel: 'Idioma de los documentos',
				langDocsHelp: 'El idioma en que los agentes redactan documentos.',
				followConversation: 'Seguir el idioma de la conversación',
				notSetAsk: 'Sin fijar (preguntar en el primer uso)',
				customLanguage: 'Personalizado…',
				customLanguagePlaceholder: 'Nombre de idioma o etiqueta BCP',
				customLanguageRequired: 'Introduce un idioma personalizado (1–48 caracteres).',
				currentValue: 'Actual: {value}',
				currentValueUnset: 'Actual: sin fijar',
				suggestedValue: 'Sugerido: {value}',
				save: 'Guardar',
				saving: 'Guardando…',
				discard: 'Descartar cambios',
				saveFailed: 'El despliegue no aceptó estos valores; se dejaron para que los corrijas.',
				saveConflict: 'Los ajustes cambiaron en otro lugar. Descarta tu borrador e inténtalo de nuevo.',
				formLoading: 'Cargando ajustes…',
				formUnavailable: 'Este plugin no está cargado, así que no puede configurarse ahora mismo.',
				formReadOnly: 'Este despliegue guarda los ajustes en modo de solo lectura.',
				dispatchSectionTitle: 'Grupos de despacho y ranking de modelos',
				dispatchSectionDescription: 'Agrupa modelos en seis grupos de despacho según la complejidad de la tarea y mantiene un ranking de capacidad; solo afecta a la delegación de dsh-switchman.',
				dispatchProgress: '{pools}/6 grupos definidos · {ranked} clasificados · modo {mode}',
				poolEconomyTitle: 'Económico · economy',
				poolEconomyDesc: 'Tareas por lotes ligeras y de baja complejidad',
				poolMechanicalTitle: 'Mecánico · mechanical',
				poolMechanicalDesc: 'Reescrituras mecánicas y operaciones con plantillas',
				poolMainTitle: 'Principal · main',
				poolMainDesc: 'Programación rutinaria y tareas cotidianas',
				poolHardTitle: 'Difícil · hard',
				poolHardDesc: 'Razonamiento difícil y refactorizaciones a gran escala',
				poolVisionTitle: 'Visión · vision',
				poolVisionDesc: 'Trabajo multimodal (imágenes)',
				poolReviewTitle: 'Revisión · review',
				poolReviewDesc: 'Revisión de solo lectura y verificación independiente',
				poolSelectAll: 'Seleccionar todo',
				poolClear: 'Limpiar',
				poolEmpty: 'No hay modelos candidatos',
				poolManualLabel: 'Orden manual',
				poolManualHelp: 'Activado, el despacho sigue el orden de la lista (el primero es la primera opción); desactivado, los carriles se ordenan automáticamente por capacidad.',
				poolManualSelected: 'Seleccionados · prioridad de despacho',
				poolManualAddable: 'Añadir modelos',
				poolMoveUp: 'Subir',
				poolMoveDown: 'Bajar',
				poolRemoveOne: 'Quitar',
				poolEffortFollow: 'seguir carril',
				poolEffortLabel: 'esfuerzo',
				poolEffortHelp: 'Fija el esfuerzo de razonamiento de este modelo; prevalece sobre el valor del carril al despachar',
				catalogLoading: 'Cargando el catálogo de modelos…',
				catalogLoadFailed: 'No se pudo cargar el catálogo de modelos.',
				catalogRetry: 'Reintentar',
				catalogPartial: 'Algunos proveedores de modelos no se pudieron cargar; las elecciones guardadas siguen pudiendo quitarse.',
				catalogEmpty: 'Ningún proveedor de modelos ofrece modelos actualmente.',
				catalogUnavailableGroup: 'Guardados pero no disponibles ahora',
				catalogUnavailable: 'no disponible actualmente',
				unauthorizedBadge: 'sin autorización para despacho explícito de subagentes en Ajustes de DSH (subagentes: selección de modelos)',
				unauthorizedHint: 'Los modelos marcados con ⚠ no están autorizados en Ajustes de DSH → Subagentes → selección de modelos; los agentes que los nombren explícitamente serán rechazados — autorízalos en los Ajustes de DSH o deja que los agentes despachen de forma implícita.',
				rankTitle: 'Ranking de capacidad',
				rankDescription: 'Numerados del más fuerte al primero; cada entrada puede anclar un nivel S/A/B/C. La lista es la selección de grupos ∪ el ranking guardado; cualquier edición persiste el orden mostrado.',
				rankEmpty: 'Selecciona modelos en los grupos de arriba; la lista del ranking aparecerá automáticamente.',
				rankTier: 'Nivel',
				rankTierNone: '—',
				rankMoveUp: 'Subir',
				rankMoveDown: 'Bajar',
				rankRemove: 'Quitar del ranking',
				enforceLabel: 'Aplicación',
				enforceOff: 'Desactivado',
				enforceAdvice: 'Consejo',
				enforceEnforce: 'Obligatorio',
				enforceHelpOff: 'No se inyecta ninguna guía de grupos en las delegaciones.',
				enforceHelpAdvice: 'La guía de grupos se inyecta como consejo; los modelos pueden desviarse.',
				enforceHelpEnforce: 'La guía de grupos se inyecta como restricción estricta; las desviaciones se rechazan.',
				wmSectionTitle: 'Nivel de contexto',
				wmSectionDescription: 'Comportamiento por niveles según el uso de tokens: consejos, lecturas limitadas y cierre, traspaso automático.',
				wmSoftLabel: 'Nivel suave (soft)',
				wmSoftHelp: 'Al superarlo aparece un aviso y se recomienda delegar o ordenar el contexto.',
				wmHardLabel: 'Nivel duro (hard)',
				wmHardHelp: 'Al superarlo se ajusta el presupuesto de lectura y se recomienda cerrar el trabajo.',
				wmForceLabel: 'Nivel forzado (force)',
				wmForceHelp: 'Al superarlo, haz copia de seguridad y traspasa a la compactación (puede ser automático).',
				wmReadBudgetLabel: 'Presupuesto de lectura',
				wmReadBudgetHelp: 'Presupuesto de tokens por lectura; cada ronda se limita al doble.',
				wmNumberInvalid: 'Introduce un número entero de {min} o más.',
				wmOrderInvalid: 'Los tres niveles deben ascender estrictamente: soft < hard < force.',
				wmDenyModeLabel: 'Comportamiento del nivel duro',
				wmDenyModeCap: 'Limitar y avisar',
				wmDenyModeDeny: 'Rechazar directamente',
				wmDenyModeHelpCap: 'Las llamadas sobre el presupuesto pasan, pero se registra un aviso.',
				wmDenyModeHelpDeny: 'Las llamadas sobre el presupuesto se rechazan directamente.',
				wmAutoHandoverLabel: 'Traspaso automático',
				wmAutoHandoverHelp: 'En el nivel forzado, hace copia de seguridad y traspasa a la compactación automáticamente.',
				wmSubagentTitle: 'Subagentes',
				wmSubagentCapLabel: 'Tope de contexto de subagentes',
				wmSubagentCapHelp: 'Permite que los subagentes usen el umbral forzado propio de abajo; desactivado = seguir por completo los tres niveles de arriba.',
				wmSubagentForceLabel: 'Umbral forzado de subagentes',
				wmSubagentForceHelp: 'Solo sobrescribe el nivel forzado de los subagentes (soft/hard se comparten con la sesión principal); 0 sigue el nivel forzado de arriba.',
				wmSubagentFollowForce: 'Seguir el nivel forzado (0)',
				wmCommands: 'Comandos: /ctx-pause suspende las acciones del nivel · /ctx-resume las reanuda · /ctx-handover hace copia y traspasa ahora.',
				teamsSectionTitle: 'Equipos de agentes',
				teamsSectionDescription: 'Cambia la forma de despacho: desactivado es despacho simple de subagentes (aplica la política conservadora de fábrica de DSH); activado inyecta la doctrina de equipo autónomo y habilita Agent Teams.',
				teamsModeLabel: 'Modo de equipos de agentes',
				teamsModeHelp: 'Activado, se inyecta la doctrina de equipo (delegar por defecto + verificación por niveles + disciplina del tablero de tareas) y se habilita el paquete Agent Teams de DSH; las insignias ⚠ de autorización de los grupos de despacho solo se muestran en este modo.',
				syncWhitelistLabel: 'Sincronizar la lista blanca de modelos de subagentes',
				syncWhitelistHelp: 'Interruptor independiente (no requiere el modo de equipos): escribe la unión de los seis grupos en la lista de autorización de «Ajustes de DSH → Subagentes → selección de modelos»; dsh-switchman pasa a ser la única fuente de verdad.',
				whitelistSyncOk: '{count} entradas sincronizadas ({time}).',
				whitelistSyncError: 'Error de sincronización: {error}',
				whitelistSyncPending: 'Esperando la sincronización…',
				whitelistSyncNote: 'Los cambios de la lista blanca solo afectan a las sesiones creadas después.',
				uiSectionTitle: 'Interfaz',
				uiSectionDescription: 'Idioma de la interfaz propia de este plugin (insignia, panel, esta página de ajustes).',
				uiLocaleLabel: 'Idioma de la interfaz',
				uiLocaleHelp: 'Automático sigue el idioma de la app DeepSeek Harness; al elegir un idioma, la interfaz del plugin se fija en él.',
				uiLocaleAuto: 'Automático (seguir DSH)',
			},
			fr: {
				badge: 'Équipe autonome',
				badgeTip: 'dsh-switchman : les quatre préréglages intégrés (standard / ptc / minimal / cordis) embarquent la doctrine d’équipe autonome des Agent Teams',
				handoverActive: 'Remise en cours',
				handoverPhaseBackup: 'sauvegarde de la session',
				handoverPhaseCompacting: 'compactage du contexte',
				handoverPhaseContinuation: 'réveil de la continuation',
				handoverActiveTip: 'Switchman effectue la remise en arrière-plan : fork d’une session de sauvegarde et compactage du contexte ; la tâche se poursuit automatiquement une fois terminée. Une session immobile pendant cette fenêtre est normale.',
				visionHintNeedsPool: 'Ce modèle ne sait pas lire les images : ajoutez des modèles au pool multimodal dans les réglages dsh-switchman, puis envoyez les images avec /vision.',
				visionHintUseVision: 'Ce modèle ne sait pas lire les images : envoyez-les avec /vision (routage automatique vers le pool multimodal).',
				visionAutoConverted: 'Envoi d’image refusé : renvoi automatique via /vision (lecture par le pool multimodal).',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman',
				settingsDescription: 'Configurez les préférences de dsh-switchman.',
				langSectionTitle: 'Langue',
				langSectionDescription: 'Détermine la langue des réponses des agents, des commentaires de code et des documents rédigés.',
				langScopeLabel: 'Portée de la langue',
				langScopeHelp: 'Là où ces préférences de langue sont conservées.',
				langScopeGlobal: 'Global (ce profil)',
				langScopeProject: 'Par projet (.switchman/lang.json)',
				langProjectNote: 'Mode par projet : chaque projet lit son propre .switchman/lang.json ; les réponses données au premier usage y sont enregistrées, et les sessions posent la question tant qu’il n’existe pas. Les trois champs ci-dessous ne s’appliquent qu’en mode global.',
				langConversationLabel: 'Langue des conversations',
				langConversationHelp: 'La langue dans laquelle les agents répondent et discutent ; si elle n’est pas réglée, on vous la demande une fois au premier usage et le choix est retenu.',
				langCommentsLabel: 'Langue des commentaires de code',
				langCommentsHelp: 'La langue dans laquelle les agents écrivent les commentaires de code.',
				langDocsLabel: 'Langue des documents',
				langDocsHelp: 'La langue dans laquelle les agents rédigent les documents.',
				followConversation: 'Suivre la langue de la conversation',
				notSetAsk: 'Non réglée (demander au premier usage)',
				customLanguage: 'Personnalisée…',
				customLanguagePlaceholder: 'Nom de langue ou étiquette BCP',
				customLanguageRequired: 'Saisissez une langue personnalisée (1–48 caractères).',
				currentValue: 'Actuel : {value}',
				currentValueUnset: 'Actuel : non réglé',
				suggestedValue: 'Suggéré : {value}',
				save: 'Enregistrer',
				saving: 'Enregistrement…',
				discard: 'Annuler les modifications',
				saveFailed: 'Le déploiement n’a pas accepté ces valeurs ; elles ont été laissées à corriger.',
				saveConflict: 'Les réglages ont changé ailleurs. Abandonnez votre brouillon et réessayez.',
				formLoading: 'Chargement des réglages…',
				formUnavailable: 'Ce plugin n’est pas chargé : impossible de le configurer pour le moment.',
				formReadOnly: 'Ce déploiement stocke les réglages en lecture seule.',
				dispatchSectionTitle: 'Pools de dispatch et classement des modèles',
				dispatchSectionDescription: 'Répartit les modèles en six pools de dispatch selon la complexité des tâches et maintient un classement de capacité ; n’affecte que la délégation dsh-switchman.',
				dispatchProgress: '{pools}/6 pools réglés · {ranked} classés · mode {mode}',
				poolEconomyTitle: 'Économie',
				poolEconomyDesc: 'Tâches légères en série et de faible complexité',
				poolMechanicalTitle: 'Mécanique',
				poolMechanicalDesc: 'Réécritures mécaniques et opérations sur gabarit',
				poolMainTitle: 'Principal',
				poolMainDesc: 'Code au quotidien et tâches courantes',
				poolHardTitle: 'Difficile',
				poolHardDesc: 'Raisonnement corsé et refontes à grande échelle',
				poolVisionTitle: 'Vision',
				poolVisionDesc: 'Travail multimodal (images)',
				poolReviewTitle: 'Relecture',
				poolReviewDesc: 'Relecture en lecture seule et vérification indépendante',
				poolSelectAll: 'Tout cocher',
				poolClear: 'Effacer',
				poolEmpty: 'Aucun modèle candidat',
				poolManualLabel: 'Ordre manuel',
				poolManualHelp: 'Activé, le dispatch suit l’ordre affiché (la tête = premier choix) ; désactivé, les couloirs sont ordonnés par capacité automatiquement.',
				poolManualSelected: 'Sélectionnés · priorité de dispatch',
				poolManualAddable: 'Ajouter des modèles',
				poolMoveUp: 'Monter',
				poolMoveDown: 'Descendre',
				poolRemoveOne: 'Retirer',
				poolEffortFollow: 'suivre le couloir',
				poolEffortLabel: 'effort',
				poolEffortHelp: 'Épingle l’effort de raisonnement de ce modèle ; il prime le défaut du couloir au dispatch',
				catalogLoading: 'Chargement du catalogue de modèles…',
				catalogLoadFailed: 'Le catalogue de modèles n’a pas pu être chargé.',
				catalogRetry: 'Réessayer',
				catalogPartial: 'Certains fournisseurs de modèles n’ont pas pu être chargés ; les choix enregistrés restent retirables.',
				catalogEmpty: 'Aucun fournisseur de modèles n’annonce de modèle pour l’instant.',
				catalogUnavailableGroup: 'Enregistrés mais actuellement indisponibles',
				catalogUnavailable: 'actuellement indisponible',
				unauthorizedBadge: 'non autorisé pour le dispatch enfant explicite dans les réglages DSH (subagents : sélection de modèle)',
				unauthorizedHint: 'Les modèles marqués ⚠ ne sont pas autorisés dans Réglages DSH → Subagents → sélection de modèle ; les agents qui les nomment explicitement se verront refuser le dispatch — autorisez-les dans les réglages DSH, ou laissez les agents dispatcher implicitement.',
				rankTitle: 'Classement de capacité',
				rankDescription: 'Numérotés du plus fort au moins fort ; chaque entrée peut ancrer un tier S/A/B/C. La liste est sélection des pools ∪ classement enregistré ; toute modification rend l’ordre affiché persistant.',
				rankEmpty: 'Cochez des modèles dans les pools ci-dessus ; la liste de classement apparaît automatiquement.',
				rankTier: 'Tier',
				rankTierNone: '—',
				rankMoveUp: 'Monter',
				rankMoveDown: 'Descendre',
				rankRemove: 'Retirer du classement',
				enforceLabel: 'Exécution',
				enforceOff: 'Off',
				enforceAdvice: 'Advice',
				enforceEnforce: 'Enforce',
				enforceHelpOff: 'Aucune recommandation de pool n’est injectée dans la délégation.',
				enforceHelpAdvice: 'Les recommandations de pool sont injectées à titre de conseil (advice) ; les modèles peuvent s’en écarter.',
				enforceHelpEnforce: 'Les recommandations de pool sont injectées comme contrainte stricte ; tout écart est refusé.',
				wmSectionTitle: 'Niveau d’eau du contexte',
				wmSectionDescription: 'Comportement par paliers selon l’usage des tokens : conseil, lectures plafonnées et phase de clôture, remise automatique.',
				wmSoftLabel: 'Ligne d’eau soft',
				wmSoftHelp: 'Au-delà, une bannière apparaît et il est conseillé de déléguer ou de ranger le contexte.',
				wmHardLabel: 'Ligne d’eau hard',
				wmHardHelp: 'Au-delà, le budget de lecture se resserre et il est conseillé de conclure.',
				wmForceLabel: 'Ligne d’eau force',
				wmForceHelp: 'Au-delà, sauvegardez et remettez à la compaction (peut être automatique).',
				wmReadBudgetLabel: 'Budget de lecture',
				wmReadBudgetHelp: 'Budget de tokens par lecture ; chaque tour plafonne au double.',
				wmNumberInvalid: 'Saisissez un nombre entier d’au moins {min}.',
				wmOrderInvalid: 'Les trois paliers doivent strictement monter : soft < hard < force.',
				wmDenyModeLabel: 'Comportement au palier hard',
				wmDenyModeCap: 'Plafonner et avertir',
				wmDenyModeDeny: 'Refuser d’office',
				wmDenyModeHelpCap: 'Les appels au-delà du budget passent, mais un avertissement est consigné.',
				wmDenyModeHelpDeny: 'Les appels au-delà du budget sont refusés d’office.',
				wmAutoHandoverLabel: 'Remise automatique',
				wmAutoHandoverHelp: 'À la ligne d’eau force, sauvegarde et remise automatiques à la compaction.',
				wmSubagentTitle: 'Subagents',
				wmSubagentCapLabel: 'Plafond de contexte des subagents',
				wmSubagentCapHelp: 'Laisse les subagents utiliser le seuil force dédié ci-dessous ; désactivé = suivent intégralement les trois paliers ci-dessus.',
				wmSubagentForceLabel: 'Seuil force des subagents',
				wmSubagentForceHelp: 'Ne remplace que le palier force des subagents (soft/hard partagés avec la session principale) ; 0 suit la ligne d’eau force ci-dessus.',
				wmSubagentFollowForce: 'Suivre le palier force (0)',
				wmCommands: 'Commandes : /ctx-pause suspend les actions de niveau d’eau · /ctx-resume les reprend · /ctx-handover sauvegarde et remet maintenant.',
				teamsSectionTitle: 'Agent Teams',
				teamsSectionDescription: 'Change la forme du dispatch : éteint, c’est le dispatch subagent simple (la politique d’équipe prudente d’usine de DSH reprend la main) ; allumé, la doctrine d’équipe autonome est injectée et les Agent Teams sont activés.',
				teamsModeLabel: 'Mode Agent Teams',
				teamsModeHelp: 'Activé, la doctrine d’équipe (délégation par défaut + vérification par paliers + discipline du tableau de tâches) est injectée et le bundle DSH Agent Teams est activé ; les badges ⚠ d’autorisation des pools de dispatch n’apparaissent que dans ce mode.',
				syncWhitelistLabel: 'Synchroniser la liste blanche des modèles de subagents',
				syncWhitelistHelp: 'Interrupteur indépendant (ne dépend pas du mode Agent Teams) : écrit l’union des six pools dans la liste d’autorisation « Réglages DSH → Subagents → sélection de modèle » ; dsh-switchman devient l’unique source de vérité.',
				whitelistSyncOk: '{count} entrées synchronisées ({time}).',
				whitelistSyncError: 'Échec de la synchronisation : {error}',
				whitelistSyncPending: 'Synchronisation en attente…',
				whitelistSyncNote: 'Les changements de liste blanche ne s’appliquent qu’aux sessions créées ensuite.',
				uiSectionTitle: 'Interface',
				uiSectionDescription: 'Langue d’affichage de l’interface propre du plugin (badge, panneau, cette page de réglages).',
				uiLocaleLabel: 'Langue de l’interface',
				uiLocaleHelp: 'Auto suit la langue de l’application DeepSeek Harness ; choisir une langue force l’interface du plugin dans cette langue.',
				uiLocaleAuto: 'Auto (suivre DSH)',
			},
			it: {
				badge: 'Squadra autonoma',
				badgeTip: 'dsh-switchman: i quattro preset integrati (standard / ptc / minimal / cordis) portano con sé la dottrina di squadra autonoma degli Agent Teams',
				handoverActive: 'Handover in corso',
				handoverPhaseBackup: 'backup della sessione',
				handoverPhaseCompacting: 'compattazione del contesto',
				handoverPhaseContinuation: 'risveglio della continuazione',
				handoverActiveTip: 'Switchman sta facendo l’handover in background: fork di una sessione di backup e compattazione del contesto; finito quello, il task prosegue da solo. Una sessione ferma in questa finestra è normale.',
				visionHintNeedsPool: 'Questo modello non sa leggere le immagini: aggiungi modelli al pool multimodale nelle impostazioni di dsh-switchman, poi invia le immagini con /vision.',
				visionHintUseVision: 'Questo modello non sa leggere le immagini: inviale con /vision (instradate automaticamente al pool multimodale).',
				visionAutoConverted: 'Invio dell’immagine rifiutato: reinvio automatico via /vision (lettura dal pool multimodale).',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman',
				settingsDescription: 'Configura le preferenze di dsh-switchman.',
				langSectionTitle: 'Lingua',
				langSectionDescription: 'Controlla la lingua delle risposte degli agent, dei commenti al codice e dei documenti prodotti.',
				langScopeLabel: 'Ambito della lingua',
				langScopeHelp: 'Dove vengono conservate queste preferenze linguistiche.',
				langScopeGlobal: 'Globale (questo profilo)',
				langScopeProject: 'Per progetto (.switchman/lang.json)',
				langProjectNote: 'Modalità per progetto: ogni progetto legge il proprio .switchman/lang.json; le risposte date al primo uso vengono salvate lì, e le sessioni continuano a chiedere finché il file non esiste. I tre campi sottostanti valgono solo in modalità globale.',
				langConversationLabel: 'Lingua della conversazione',
				langConversationHelp: 'La lingua in cui gli agent rispondono e discutono; se non è impostata, viene chiesta una volta al primo uso e la scelta viene ricordata.',
				langCommentsLabel: 'Lingua dei commenti al codice',
				langCommentsHelp: 'La lingua in cui gli agent scrivono i commenti al codice.',
				langDocsLabel: 'Lingua dei documenti',
				langDocsHelp: 'La lingua in cui gli agent redigono i documenti.',
				followConversation: 'Segui la lingua della conversazione',
				notSetAsk: 'Non impostata (chiedi al primo uso)',
				customLanguage: 'Personalizzata…',
				customLanguagePlaceholder: 'Nome della lingua o tag BCP',
				customLanguageRequired: 'Inserisci una lingua personalizzata (1–48 caratteri).',
				currentValue: 'Attuale: {value}',
				currentValueUnset: 'Attuale: non impostata',
				suggestedValue: 'Suggerita: {value}',
				save: 'Salva',
				saving: 'Salvataggio…',
				discard: 'Annulla le modifiche',
				saveFailed: 'Il deployment non ha accettato questi valori; sono stati lasciati a te da correggere.',
				saveConflict: 'Le impostazioni sono cambiate altrove. Scarta la bozza e riprova.',
				formLoading: 'Caricamento delle impostazioni…',
				formUnavailable: 'Questo plugin non è caricato, quindi non è configurabile al momento.',
				formReadOnly: 'Questo deployment salva le impostazioni in sola lettura.',
				dispatchSectionTitle: 'Pool di dispatch e classifica dei modelli',
				dispatchSectionDescription: 'Raggruppa i modelli in sei pool di dispatch per complessità del task e mantiene una classifica di capacità; incide solo sulla delega di dsh-switchman.',
				dispatchProgress: '{pools}/6 pool impostati · {ranked} classificati · modalità {mode}',
				poolEconomyTitle: 'Economia',
				poolEconomyDesc: 'Lavori piccoli in serie e a bassa complessità',
				poolMechanicalTitle: 'Meccanico',
				poolMechanicalDesc: 'Riscritture meccaniche e operazioni su schema',
				poolMainTitle: 'Principale',
				poolMainDesc: 'Coding di tutti i giorni e attività quotidiane',
				poolHardTitle: 'Difficile',
				poolHardDesc: 'Ragionamento complesso e refactoring su larga scala',
				poolVisionTitle: 'Visione',
				poolVisionDesc: 'Lavoro multimodale (immagini)',
				poolReviewTitle: 'Revisione',
				poolReviewDesc: 'Revisione in sola lettura e verifica indipendente',
				poolSelectAll: 'Seleziona tutto',
				poolClear: 'Azzera',
				poolEmpty: 'Nessun modello candidato',
				poolManualLabel: 'Ordine manuale',
				poolManualHelp: 'Attivo, il dispatch segue l’ordine elencato (il primo della lista = prima scelta); spento, le corsie vengono ordinate per capacità automaticamente.',
				poolManualSelected: 'Selezionati · priorità di dispatch',
				poolManualAddable: 'Aggiungi modelli',
				poolMoveUp: 'Sposta su',
				poolMoveDown: 'Sposta giù',
				poolRemoveOne: 'Rimuovi',
				poolEffortFollow: 'segui la corsia',
				poolEffortLabel: 'effort',
				poolEffortHelp: 'Fissa il reasoning effort di questo modello; prevale sul default della corsia in fase di dispatch',
				catalogLoading: 'Caricamento del catalogo modelli…',
				catalogLoadFailed: 'Impossibile caricare il catalogo dei modelli.',
				catalogRetry: 'Riprova',
				catalogPartial: 'Alcuni provider di modelli non sono stati caricati; le scelte salvate restano rimovibili.',
				catalogEmpty: 'Nessun provider di modelli al momento propone un modello.',
				catalogUnavailableGroup: 'Salvati ma al momento non disponibili',
				catalogUnavailable: 'al momento non disponibile',
				unauthorizedBadge: 'non autorizzato per il dispatch esplicito dei figli nelle impostazioni DSH (subagent: selezione modelli)',
				unauthorizedHint: 'I modelli contrassegnati ⚠ non sono autorizzati in Impostazioni DSH → Subagent → selezione modelli; gli agent che li nominano esplicitamente vengono negati — autorizzali nelle impostazioni DSH, oppure lascia dispatch implicito agli agent.',
				rankTitle: 'Classifica di capacità',
				rankDescription: 'Numerati dal più forte in giù; ogni voce può ancorare una fascia S/A/B/C. L’elenco è selezioni dei pool ∪ classifica salvata; ogni modifica rende persistente l’ordine mostrato.',
				rankEmpty: 'Seleziona modelli nei pool sopra; la classifica compare da sola.',
				rankTier: 'Fascia',
				rankTierNone: '—',
				rankMoveUp: 'Sposta su',
				rankMoveDown: 'Sposta giù',
				rankRemove: 'Rimuovi dalla classifica',
				enforceLabel: 'Esecuzione',
				enforceOff: 'Off',
				enforceAdvice: 'Advice',
				enforceEnforce: 'Enforce',
				enforceHelpOff: 'Nessuna raccomandazione di pool viene iniettata nella delega.',
				enforceHelpAdvice: 'Le raccomandazioni dei pool entrano come consiglio (advice); i modelli possono discostarsene.',
				enforceHelpEnforce: 'Le raccomandazioni dei pool entrano come vincolo rigido; gli scostamenti vengono rifiutati.',
				wmSectionTitle: 'Livello dell’acqua del contesto',
				wmSectionDescription: 'Comportamento a soglie in base ai token usati: consiglio, letture col tetto e chiusura, handover automatico.',
				wmSoftLabel: 'Soglia soft',
				wmSoftHelp: 'Superata, compare un banner e conviene delegare o sistemare il contesto.',
				wmHardLabel: 'Soglia hard',
				wmHardHelp: 'Superata, il budget di lettura si stringe e conviene chiudere.',
				wmForceLabel: 'Soglia force',
				wmForceHelp: 'Superata, backup e handover alla compattazione (può essere automatico).',
				wmReadBudgetLabel: 'Budget di lettura',
				wmReadBudgetHelp: 'Budget di token per lettura; ogni turno arriva al massimo al doppio.',
				wmNumberInvalid: 'Inserisci un numero intero di almeno {min}.',
				wmOrderInvalid: 'Le tre soglie devono salire rigorosamente: soft < hard < force.',
				wmDenyModeLabel: 'Comportamento alla soglia hard',
				wmDenyModeCap: 'Tetto e avviso',
				wmDenyModeDeny: 'Rifiuto secco',
				wmDenyModeHelpCap: 'Le chiamate oltre budget passano, ma viene registrato un avviso.',
				wmDenyModeHelpDeny: 'Le chiamate oltre budget vengono rifiutate sul posto.',
				wmAutoHandoverLabel: 'Handover automatico',
				wmAutoHandoverHelp: 'Alla soglia force, backup e handover alla compattazione avvengono da soli.',
				wmSubagentTitle: 'Subagent',
				wmSubagentCapLabel: 'Tetto di contesto dei subagent',
				wmSubagentCapHelp: 'Lascia i subagent usare la soglia force dedicata qui sotto; spento = seguono appieno le tre soglie sopra.',
				wmSubagentForceLabel: 'Soglia force dei subagent',
				wmSubagentForceHelp: 'Sostituisce solo la soglia force dei subagent (soft/hard restano condivise con la sessione principale); 0 segue la soglia force sopra.',
				wmSubagentFollowForce: 'Segui la soglia force (0)',
				wmCommands: 'Comandi: /ctx-pause sospende le azioni da livello dell’acqua · /ctx-resume le riprende · /ctx-handover fa backup e handover subito.',
				teamsSectionTitle: 'Agent Teams',
				teamsSectionDescription: 'Cambia la forma del dispatch: spento è il semplice dispatch via subagent (subentra la politica di squadra prudente di fabbrica di DSH); acceso inietta la dottrina di squadra autonoma e abilita gli Agent Teams.',
				teamsModeLabel: 'Modalità Agent Teams',
				teamsModeHelp: 'Accesa, la dottrina di squadra (delega per default + verifica a livelli + disciplina del task board condiviso) viene iniettata e il bundle Agent Teams di DSH viene abilitato; i badge ⚠ di autorizzazione dei pool di dispatch compaiono solo in questa modalità.',
				syncWhitelistLabel: 'Sincronizza la whitelist dei modelli per i subagent',
				syncWhitelistHelp: 'Interruttore indipendente (non richiede la modalità Agent Teams): scrive l’unione dei sei pool nella lista di autorizzazione «Impostazioni DSH → Subagent → selezione modelli»; dsh-switchman diventa l’unica fonte di verità.',
				whitelistSyncOk: 'Sincronizzate {count} voci ({time}).',
				whitelistSyncError: 'Sincronizzazione fallita: {error}',
				whitelistSyncPending: 'In attesa di sincronizzare…',
				whitelistSyncNote: 'Le modifiche alla whitelist valgono solo per le sessioni create dopo.',
				uiSectionTitle: 'Interfaccia',
				uiSectionDescription: 'Lingua di visualizzazione dell’interfaccia del plugin stesso (badge, pannello, questa pagina di impostazioni).',
				uiLocaleLabel: 'Lingua dell’interfaccia',
				uiLocaleHelp: 'Auto segue la lingua dell’app DeepSeek Harness; scegliere una lingua forza l’interfaccia del plugin in quella lingua.',
				uiLocaleAuto: 'Auto (segui DSH)',
			},
			pt: {
				badge: 'Equipe autônoma',
				badgeTip: 'dsh-switchman: os quatro presets embutidos (standard / ptc / minimal / cordis) carregam a doutrina de equipe autônoma do Agent Teams',
				handoverActive: 'Handover em andamento',
				handoverPhaseBackup: 'backup da sessão',
				handoverPhaseCompacting: 'compactação do contexto',
				handoverPhaseContinuation: 'despertar da continuação',
				handoverActiveTip: 'O Switchman está fazendo o handover em segundo plano: fork de uma sessão de backup e compactação do contexto; ao terminar, a tarefa continua automaticamente. Uma sessão parada durante essa janela é esperada.',
				visionHintNeedsPool: 'Este modelo não sabe ler imagens: adicione modelos ao pool multimodal nas configurações do dsh-switchman e depois envie imagens com /vision.',
				visionHintUseVision: 'Este modelo não sabe ler imagens: envie-as com /vision (roteadas automaticamente para o pool multimodal).',
				visionAutoConverted: 'Envio da imagem recusado: reenvio automático via /vision (leitura pelo pool multimodal).',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman',
				settingsDescription: 'Configure as preferências do dsh-switchman.',
				langSectionTitle: 'Idioma',
				langSectionDescription: 'Controla o idioma das respostas dos agents, dos comentários de código e dos documentos redigidos.',
				langScopeLabel: 'Escopo do idioma',
				langScopeHelp: 'Onde essas preferências de idioma ficam guardadas.',
				langScopeGlobal: 'Global (este perfil)',
				langScopeProject: 'Por projeto (.switchman/lang.json)',
				langProjectNote: 'Modo por projeto: cada projeto lê o próprio .switchman/lang.json; as respostas do primeiro uso são salvas lá, e as sessões perguntam até o arquivo existir. Os três campos abaixo valem apenas no modo global.',
				langConversationLabel: 'Idioma da conversa',
				langConversationHelp: 'O idioma em que os agents respondem e discutem; sem valor definido, perguntam uma vez no primeiro uso e a escolha fica guardada.',
				langCommentsLabel: 'Idioma dos comentários de código',
				langCommentsHelp: 'O idioma em que os agents escrevem comentários de código.',
				langDocsLabel: 'Idioma dos documentos',
				langDocsHelp: 'O idioma em que os agents redigem documentos.',
				followConversation: 'Seguir o idioma da conversa',
				notSetAsk: 'Não definido (perguntar no primeiro uso)',
				customLanguage: 'Personalizado…',
				customLanguagePlaceholder: 'Nome de idioma ou tag BCP',
				customLanguageRequired: 'Informe um idioma personalizado (1–48 caracteres).',
				currentValue: 'Atual: {value}',
				currentValueUnset: 'Atual: não definido',
				suggestedValue: 'Sugerido: {value}',
				save: 'Salvar',
				saving: 'Salvando…',
				discard: 'Descartar alterações',
				saveFailed: 'O deployment não aceitou estes valores; eles ficaram para você corrigir.',
				saveConflict: 'As configurações mudaram em outro lugar. Descarte o rascunho e tente de novo.',
				formLoading: 'Carregando configurações…',
				formUnavailable: 'Este plugin não está carregado, então não pode ser configurado agora.',
				formReadOnly: 'Este deployment guarda as configurações em modo somente leitura.',
				dispatchSectionTitle: 'Pools de despacho e ranking de modelos',
				dispatchSectionDescription: 'Agrupa os modelos em seis pools de despacho por complexidade da tarefa e mantém um ranking de capacidade; afeta apenas o despacho do dsh-switchman.',
				dispatchProgress: '{pools}/6 pools definidos · {ranked} no ranking · modo {mode}',
				poolEconomyTitle: 'Economia',
				poolEconomyDesc: 'Tarefas leves em lote e de baixa complexidade',
				poolMechanicalTitle: 'Mecânico',
				poolMechanicalDesc: 'Reescritas mecânicas e operações de molde',
				poolMainTitle: 'Principal',
				poolMainDesc: 'Codificação do dia a dia e tarefas correntes',
				poolHardTitle: 'Difícil',
				poolHardDesc: 'Raciocínio pesado e refatoração em grande escala',
				poolVisionTitle: 'Visão',
				poolVisionDesc: 'Trabalho multimodal (imagens)',
				poolReviewTitle: 'Revisão',
				poolReviewDesc: 'Revisão somente leitura e verificação independente',
				poolSelectAll: 'Marcar todos',
				poolClear: 'Limpar',
				poolEmpty: 'Nenhum modelo candidato',
				poolManualLabel: 'Ordem manual',
				poolManualHelp: 'Ligado, o despacho segue a ordem listada (o primeiro = primeira escolha); desligado, as faixas são ordenadas por capacidade automaticamente.',
				poolManualSelected: 'Selecionados · prioridade de despacho',
				poolManualAddable: 'Adicionar modelos',
				poolMoveUp: 'Mover para cima',
				poolMoveDown: 'Mover para baixo',
				poolRemoveOne: 'Remover',
				poolEffortFollow: 'seguir a faixa',
				poolEffortLabel: 'effort',
				poolEffortHelp: 'Fixa o reasoning effort deste modelo; sobrepõe o padrão da faixa no despacho',
				catalogLoading: 'Carregando o catálogo de modelos…',
				catalogLoadFailed: 'Não foi possível carregar o catálogo de modelos.',
				catalogRetry: 'Tentar de novo',
				catalogPartial: 'Alguns provedores de modelos não foram carregados; as escolhas salvas continuam removíveis.',
				catalogEmpty: 'Nenhum provedor de modelos anuncia um modelo no momento.',
				catalogUnavailableGroup: 'Salvos, mas indisponíveis no momento',
				catalogUnavailable: 'indisponível no momento',
				unauthorizedBadge: 'não autorizado para despacho explícito de filhos nas configurações do DSH (subagents: seleção de modelos)',
				unauthorizedHint: 'Modelos marcados com ⚠ não estão autorizados em Configurações do DSH → Subagents → seleção de modelos; agents que os nomearem explicitamente serão negados — autorize-os nas configurações do DSH, ou deixe os agents despachar implicitamente.',
				rankTitle: 'Ranking de capacidade',
				rankDescription: 'Numerados do mais forte para baixo; cada entrada pode ancorar um nível S/A/B/C. A lista é seleção dos pools ∪ ranking salvo; qualquer edição persiste a ordem exibida.',
				rankEmpty: 'Marque modelos nos pools acima; o ranking aparece sozinho.',
				rankTier: 'Nível',
				rankTierNone: '—',
				rankMoveUp: 'Mover para cima',
				rankMoveDown: 'Mover para baixo',
				rankRemove: 'Remover do ranking',
				enforceLabel: 'Execução',
				enforceOff: 'Off',
				enforceAdvice: 'Advice',
				enforceEnforce: 'Enforce',
				enforceHelpOff: 'Nenhuma orientação de pool é injetada no despacho.',
				enforceHelpAdvice: 'A orientação dos pools entra como conselho (advice); os modelos podem desviar.',
				enforceHelpEnforce: 'A orientação dos pools entra como restrição rígida; desvios são recusados.',
				wmSectionTitle: 'Nível de água do contexto',
				wmSectionDescription: 'Comportamento em degraus conforme o uso de tokens: conselho, leituras com teto e encerramento, handover automático.',
				wmSoftLabel: 'Limiar soft',
				wmSoftHelp: 'Além dele, aparece um banner e delegar ou arrumar o contexto é recomendado.',
				wmHardLabel: 'Limiar hard',
				wmHardHelp: 'Além dele, o orçamento de leitura aperta e convém encerrar.',
				wmForceLabel: 'Limiar force',
				wmForceHelp: 'Além dele, backup e handover para a compactação (pode ser automático).',
				wmReadBudgetLabel: 'Orçamento de leitura',
				wmReadBudgetHelp: 'Orçamento de tokens por leitura; cada turno se limita ao dobro disso.',
				wmNumberInvalid: 'Informe um número inteiro de {min} ou mais.',
				wmOrderInvalid: 'Os três limiares devem subir estritamente: soft < hard < force.',
				wmDenyModeLabel: 'Comportamento no limiar hard',
				wmDenyModeCap: 'Limitar e avisar',
				wmDenyModeDeny: 'Negar na hora',
				wmDenyModeHelpCap: 'Chamadas acima do orçamento passam, mas um aviso é registrado.',
				wmDenyModeHelpDeny: 'Chamadas acima do orçamento são negadas na hora.',
				wmAutoHandoverLabel: 'Handover automático',
				wmAutoHandoverHelp: 'No limiar force, backup e handover para a compactação acontecem sozinhos.',
				wmSubagentTitle: 'Subagents',
				wmSubagentCapLabel: 'Teto de contexto dos subagents',
				wmSubagentCapHelp: 'Deixa os subagents usar o limiar force dedicado abaixo; desligado = seguem integralmente os três limiares acima.',
				wmSubagentForceLabel: 'Limiar force dos subagents',
				wmSubagentForceHelp: 'Sobrepõe apenas o limiar force dos subagents (soft/hard são compartilhados com a sessão principal); 0 segue o limiar force acima.',
				wmSubagentFollowForce: 'Seguir o limiar force (0)',
				wmCommands: 'Comandos: /ctx-pause suspende as ações de nível de água · /ctx-resume as retoma · /ctx-handover faz backup e handover agora.',
				teamsSectionTitle: 'Agent Teams',
				teamsSectionDescription: 'Muda o formato do despacho: desligado é o despacho simples via subagent (entra a política conservadora de equipe de fábrica do DSH); ligado injeta a doutrina de equipe autônoma e habilita os Agent Teams.',
				teamsModeLabel: 'Modo Agent Teams',
				teamsModeHelp: 'Ligado, a doutrina de equipe (delegar por padrão + verificação em níveis + disciplina do quadro de tarefas compartilhado) é injetada e o bundle Agent Teams do DSH fica habilitado; os badges ⚠ de autorização dos pools de despacho aparecem apenas neste modo.',
				syncWhitelistLabel: 'Sincronizar a whitelist de modelos dos subagents',
				syncWhitelistHelp: 'Chave independente (não depende do modo Agent Teams): grava a união dos seis pools na lista de autorização “Configurações do DSH → Subagents → seleção de modelos”; o dsh-switchman vira a única fonte da verdade.',
				whitelistSyncOk: 'Sincronizadas {count} entradas ({time}).',
				whitelistSyncError: 'Falha na sincronização: {error}',
				whitelistSyncPending: 'Aguardando sincronizar…',
				whitelistSyncNote: 'Mudanças na whitelist só valem para sessões criadas depois.',
				uiSectionTitle: 'Interface',
				uiSectionDescription: 'Idioma de exibição da interface do próprio plugin (badge, painel, esta página de configurações).',
				uiLocaleLabel: 'Idioma da interface',
				uiLocaleHelp: 'Auto segue o idioma do aplicativo DeepSeek Harness; escolher um idioma força a interface do plugin para ele.',
				uiLocaleAuto: 'Auto (seguir DSH)',
			},
			ru: {
				badge: 'Автономная команда',
				badgeTip: 'dsh-switchman: четыре встроенных пресета (standard / ptc / minimal / cordis) несут с собой регламент автономной команды Agent Teams',
				handoverActive: 'Идёт передача',
				handoverPhaseBackup: 'резервная сессия',
				handoverPhaseCompacting: 'сжатие контекста',
				handoverPhaseContinuation: 'пробуждение продолжения',
				handoverActiveTip: 'Switchman передаёт контекст в фоне: форкает резервную сессию и сжимает контекст; по завершении задача продолжается автоматически. Неподвижная сессия в это окно — это нормально.',
				visionHintNeedsPool: 'Эта модель не умеет читать изображения: добавьте модели в мультимодальный пул в настройках dsh-switchman и отправляйте картинки через /vision.',
				visionHintUseVision: 'Эта модель не умеет читать изображения: отправляйте их через /vision (автоматически уйдут в мультимодальный пул).',
				visionAutoConverted: 'Отправка картинки отклонена: повторная отправка идёт автоматически через /vision (прочитает мультимодальный пул).',
				settingsTitle: 'dsh-switchman',
				panelLabel: 'Switchman',
				settingsDescription: 'Настройка предпочтений dsh-switchman.',
				langSectionTitle: 'Язык',
				langSectionDescription: 'Определяет язык ответов агентов, комментариев в коде и создаваемых документов.',
				langScopeLabel: 'Область действия языка',
				langScopeHelp: 'Где хранятся эти языковые предпочтения.',
				langScopeGlobal: 'Глобально (этот профиль)',
				langScopeProject: 'По проектам (.switchman/lang.json)',
				langProjectNote: 'Режим по проектам: каждый проект читает свой .switchman/lang.json; ответы при первом использовании сохраняются туда, и сессии спрашивают, пока файл не появится. Три поля ниже действуют только в глобальном режиме.',
				langConversationLabel: 'Язык беседы',
				langConversationHelp: 'Язык, на котором агенты отвечают и обсуждают; если не задан, спросят один раз при первом использовании и запомнят выбор.',
				langCommentsLabel: 'Язык комментариев в коде',
				langCommentsHelp: 'Язык, на котором агенты пишут комментарии в коде.',
				langDocsLabel: 'Язык документов',
				langDocsHelp: 'Язык, на котором агенты составляют документы.',
				followConversation: 'Следовать языку беседы',
				notSetAsk: 'Не задан (спросить при первом использовании)',
				customLanguage: 'Свой язык…',
				customLanguagePlaceholder: 'Название языка или BCP-тег',
				customLanguageRequired: 'Введите свой язык (1–48 символов).',
				currentValue: 'Сейчас: {value}',
				currentValueUnset: 'Сейчас: не задан',
				suggestedValue: 'Предложено: {value}',
				save: 'Сохранить',
				saving: 'Сохранение…',
				discard: 'Отменить изменения',
				saveFailed: 'Развёртывание не приняло эти значения; они оставлены вам на исправление.',
				saveConflict: 'Настройки изменились в другом месте. Откажитесь от черновика и попробуйте снова.',
				formLoading: 'Загрузка настроек…',
				formUnavailable: 'Плагин не загружен, поэтому настроить его сейчас нельзя.',
				formReadOnly: 'Это развёртывание хранит настройки в режиме только для чтения.',
				dispatchSectionTitle: 'Пулы диспетчеризации и ранжирование моделей',
				dispatchSectionDescription: 'Разбивает модели на шесть пулов диспетчеризации по сложности задач и ведёт ранжирование по силе; действует только на делегирование dsh-switchman.',
				dispatchProgress: '{pools}/6 пулов задано · {ranked} в ранжировании · режим {mode}',
				poolEconomyTitle: 'Экономия',
				poolEconomyDesc: 'Мелкие массовые задачи низкой сложности',
				poolMechanicalTitle: 'Механика',
				poolMechanicalDesc: 'Механические переработки и шаблонные операции',
				poolMainTitle: 'Основной',
				poolMainDesc: 'Повседневный кодинг и рутинные задачи',
				poolHardTitle: 'Сложный',
				poolHardDesc: 'Тяжёлые рассуждения и крупные рефакторинги',
				poolVisionTitle: 'Мультимодальный',
				poolVisionDesc: 'Мультимодальная работа (изображения)',
				poolReviewTitle: 'Ревью',
				poolReviewDesc: 'Ревью только для чтения и независимая проверка',
				poolSelectAll: 'Выбрать все',
				poolClear: 'Очистить',
				poolEmpty: 'Нет моделей-кандидатов',
				poolManualLabel: 'Ручной порядок',
				poolManualHelp: 'Включено — диспетчеризация идёт по списку (голова списка = первый выбор); выключено — полосы упорядочиваются по силе автоматически.',
				poolManualSelected: 'Выбрано · приоритет диспетчеризации',
				poolManualAddable: 'Добавить модели',
				poolMoveUp: 'Выше',
				poolMoveDown: 'Ниже',
				poolRemoveOne: 'Убрать',
				poolEffortFollow: 'следовать полосе',
				poolEffortLabel: 'effort',
				poolEffortHelp: 'Фиксирует reasoning effort этой модели; при диспетчеризации перекрывает умолчание полосы',
				catalogLoading: 'Загрузка каталога моделей…',
				catalogLoadFailed: 'Не удалось загрузить каталог моделей.',
				catalogRetry: 'Повторить',
				catalogPartial: 'Часть провайдеров моделей не загрузилась; сохранённый выбор всё ещё можно убрать.',
				catalogEmpty: 'Ни один провайдер моделей сейчас не объявляет моделей.',
				catalogUnavailableGroup: 'Сохранённые, но сейчас недоступные',
				catalogUnavailable: 'сейчас недоступна',
				unauthorizedBadge: 'не авторизовано для явной диспетчеризации потомков в настройках DSH (субагенты: выбор моделей)',
				unauthorizedHint: 'Модели с пометкой ⚠ не авторизованы в «Настройки DSH → Субагенты → выбор моделей»; явное их назначение агентом будет отклонено — авторизуйте их в настройках DSH или пусть агенты диспетчеризуют неявно.',
				rankTitle: 'Ранжирование по силе',
				rankDescription: 'Нумерация от сильнейшего; каждая запись может привязаться к ступени S/A/B/C. Список — это выбор пулов ∪ сохранённое ранжирование; любое изменение закрепляет показанный порядок.',
				rankEmpty: 'Отметьте модели в пулах выше — список ранжирования появится сам.',
				rankTier: 'Ступень',
				rankTierNone: '—',
				rankMoveUp: 'Выше',
				rankMoveDown: 'Ниже',
				rankRemove: 'Убрать из ранжирования',
				enforceLabel: 'Режим исполнения',
				enforceOff: 'Off',
				enforceAdvice: 'Advice',
				enforceEnforce: 'Enforce',
				enforceHelpOff: 'Никакие рекомендации пулов не добавляются в делегирование.',
				enforceHelpAdvice: 'Рекомендации пулов добавляются как совет (advice); модели могут от них отступать.',
				enforceHelpEnforce: 'Рекомендации пулов добавляются как жёсткое ограничение; отступления отклоняются.',
				wmSectionTitle: 'Уровень воды в контексте',
				wmSectionDescription: 'Ступенчатое поведение по расходу токенов: совет, урезание чтения и подведение итогов, автоматическая передача.',
				wmSoftLabel: 'Линия soft',
				wmSoftHelp: 'Выше неё появляется баннер, и советуется делегировать или прибрать контекст.',
				wmHardLabel: 'Линия hard',
				wmHardHelp: 'Выше неё бюджет чтения урезается и стоит подвигаться к завершению.',
				wmForceLabel: 'Линия force',
				wmForceHelp: 'Выше неё — резервная копия и передача на сжатие (может быть автоматически).',
				wmReadBudgetLabel: 'Бюджет чтения',
				wmReadBudgetHelp: 'Бюджет токенов на одно чтение; каждый ход ограничен удвоенным значением.',
				wmNumberInvalid: 'Введите целое число не меньше {min}.',
				wmOrderInvalid: 'Три линии должны строго возрастать: soft < hard < force.',
				wmDenyModeLabel: 'Поведение на линии hard',
				wmDenyModeCap: 'Урезать и предупредить',
				wmDenyModeDeny: 'Отклонять сразу',
				wmDenyModeHelpCap: 'Вызовы сверх бюджета проходят, но предупреждение записывается.',
				wmDenyModeHelpDeny: 'Вызовы сверх бюджета отклоняются сразу.',
				wmAutoHandoverLabel: 'Автоматическая передача',
				wmAutoHandoverHelp: 'На линии force — резервная копия и передача на сжатие автоматически.',
				wmSubagentTitle: 'Субагенты',
				wmSubagentCapLabel: 'Потолок контекста субагентов',
				wmSubagentCapHelp: 'Субагенты используют отдельный порог force ниже; выключено = полностью следуют трём линиям выше.',
				wmSubagentForceLabel: 'Порог force субагентов',
				wmSubagentForceHelp: 'Меняет только линию force субагентов (soft/hard общие с главной сессией); 0 — следовать линии force выше.',
				wmSubagentFollowForce: 'Следовать линии force (0)',
				wmCommands: 'Команды: /ctx-pause приостанавливает действия по уровню воды · /ctx-resume возобновляет их · /ctx-handover делает резервную копию и передаёт прямо сейчас.',
				teamsSectionTitle: 'Agent Teams',
				teamsSectionDescription: 'Переключает форму диспетчеризации: выключено — обычный dispatch через субагентов (вступает консервативная заводская командная политика DSH); включено — внедряется регламент автономной команды и включаются Agent Teams.',
				teamsModeLabel: 'Режим Agent Teams',
				teamsModeHelp: 'Включено: внедряется командный регламент (делегирование по умолчанию + многоуровневая проверка + дисциплина общей доски задач) и включается бандл DSH Agent Teams; значки ⚠ авторизации у пулов диспетчеризации показываются только в этом режиме.',
				syncWhitelistLabel: 'Синхронизировать белый список моделей субагентов',
				syncWhitelistHelp: 'Независимый переключатель (режим Agent Teams не требуется): записывает объединение шести пулов в список авторизации «Настройки DSH → Субагенты → выбор моделей»; dsh-switchman становится единственным источником истины.',
				whitelistSyncOk: 'Синхронизировано записей: {count} ({time}).',
				whitelistSyncError: 'Сбой синхронизации: {error}',
				whitelistSyncPending: 'Ожидание синхронизации…',
				whitelistSyncNote: 'Изменения белого списка действуют только на сессии, созданные после.',
				uiSectionTitle: 'Интерфейс',
				uiSectionDescription: 'Язык отображения собственного интерфейса плагина (значок, панель, эта страница настроек).',
				uiLocaleLabel: 'Язык интерфейса',
				uiLocaleHelp: '«Авто» следует языку приложения DeepSeek Harness; выбор конкретного языка принудительно переводит на него интерфейс плагина.',
				uiLocaleAuto: 'Авто (следовать DSH)',
			},
		};

		// ------------------------------------------------------------------
		// Session-header badge (Phase 0, unchanged)
		// ------------------------------------------------------------------

		/** Rotating-arc spinner (SVG SMIL animateTransform): the restricted
		 * dynamic-module runtime exposes no CSS insertion here, and SMIL
		 * animates without lifecycle code or a React state loop. */
		function HandoverSpinner() {
			return h(
				'svg',
				{
					viewBox: '0 0 16 16',
					width: 12,
					height: 12,
					'aria-hidden': true,
					style: { flex: 'none' },
				},
				h(
					'circle',
					{
						cx: 8,
						cy: 8,
						r: 6,
						fill: 'none',
						stroke: 'currentColor',
						strokeWidth: 2,
						strokeDasharray: '9 19',
						strokeLinecap: 'round',
					},
					h('animateTransform', {
						attributeName: 'transform',
						type: 'rotate',
						from: '0 8 8',
						to: '360 8 8',
						dur: '1s',
						repeatCount: 'indefinite',
					}),
				),
			);
		}

		function SwitchmanBadge({
		locale,
		t,
		sessionId,
		useProjection,
		useSessions,
	}) {

			// Subscription only: stable snapshot via getLocale() re-renders on switch.
			React.useSyncExternalStore(
				(fn) => locale.subscribe(fn),
				() => locale.getLocale(),
			);
			// Re-render when the manual interface-locale override changes.
			React.useSyncExternalStore(subscribeUiLocale, () => uiLocaleVersion);
			// Live handover cue: during the fork+compact window the session
			// GUI has no motion of its own, so the badge polls the Host's
			// handover-state route (phases recorded from runHandover's first
			// synchronous line) and flips to an animated status chip. Fast
			// cadence while in flight, slow otherwise; a failed fetch or an
			// older Host reads as "no handover" and never blocks the badge.
			const [handover, setHandover] = React.useState(null);
			React.useEffect(() => {
				let stopped = false;
				let timer = null;
				const tick = async () => {
					let live = null;
					// NOTE: the handover-state route is not session-scoped, so
					// this reflects ANY in-flight handover (cross-session bleed
					// with several open sessions) — accepted: cosmetic, and
					// the desktop GUI renders one session header at a time.
					try {
						const reply = await api.get('handover-state');
						if (reply?.ok && reply.value?.count > 0)
							live = reply.value.handovers[0] ?? null;
					} catch {
						live = null;
					}
					if (stopped) return;
					setHandover(live);
					timer = setTimeout(tick, live === null ? 10_000 : 3_000);
				};
				void tick();
				return () => {
					stopped = true;
					if (timer !== null) clearTimeout(timer);
				};
			}, []);
			// ---- Session model line ----
			// The slot is session-scoped, so `sessionId` names the open session
			// and `useProjection` reads its live projection faces (standard kit
			// members; both degrade to no-ops outside the kit, same guard shape
			// as the vision dock entry). Switching sessions re-materializes the
			// standard props, so the face re-binds and the old subscription is
			// dropped by the hook machinery — no manual lifecycle here.
			const projectionHook =
				typeof useProjection === 'function' ? useProjection : () => undefined;
			const liveSelection = projectionHook('modelSelection');
			// NEVER touch services this plugin did not declare in inject:
			// the dynamic-module guard THROWS on `ctx.<undeclared>` access
			// (ctx.sessions did exactly that and the slot occurrence error
			// boundary swallowed it — the badge silently vanished this way).
			// Session facts arrive only through framework-bound kit hooks, and
			// every selector must return a value-stable primitive.
			const sessionsHook =
				typeof useSessions === 'function' ? useSessions : () => undefined;
			// Durable metadata separates subagent sessions from root ones
			// (summary `origin`/`parentId`). A root session's model already has
			// the composer's model selector, so the line stays subagent-only.
			const subagentKey = sessionsHook((list) => {
				if (list == null) return 'absent';
				const summary =
					sessionId != null ? list.byId?.[sessionId] : undefined;
				if (summary === undefined) return 'absent';
				return summary.origin === 'subagent' ||
					summary.parentId !== undefined
					? 'subagent'
					: 'root';
			});
			const isSubagent = subagentKey === 'subagent';
			// Fallback for sessions whose retained face has not carried the
			// key yet: the manager's shared list snapshot often already holds
			// explicitly loaded projections (sidebar-visible subagents).
			const fallbackText = sessionsHook((list) => {
				if (list == null) return '';
				const selection =
					sessionId != null
						? list.projectionsBySession?.[sessionId]?.values
								?.modelSelection
						: undefined;
				const model = selection?.next ?? selection?.lastUsed;
				if (model == null) return '';
				return `${model.provider}/${model.model}${
					model.reasoningEffort ? `@${model.reasoningEffort}` : ''
				}`;
			});
			const liveModel =
				liveSelection?.next ?? liveSelection?.lastUsed ?? null;
			const modelText =
				liveModel == null
					? (fallbackText ?? '')
					: `${liveModel.provider}/${liveModel.model}${
							liveModel.reasoningEffort
								? `@${liveModel.reasoningEffort}`
								: ''
						}`;
			const modelChip =
				isSubagent && modelText !== ''
					? h(
							'span',
							{
								title: modelText,
								'data-dsh-switchman': 'session-model',
								style: {
									borderRadius: 'var(--dsw-radius-xs)',
									height: '22px',
									color: 'var(--dsw-alias-label-tertiary)',
									whiteSpace: 'nowrap',
									display: 'inline-flex',
									alignItems: 'center',
									gap: '4px',
									padding: '0 8px',
									fontSize: '12px',
									lineHeight: '22px',
									flex: 'none',
								},
							},
							h('span', { 'aria-hidden': true, style: { flex: 'none' } }, '◇'),
							h('span', null, modelText),
						)
					: null;
			/** Append the model chip without disturbing the status chip shapes. */
			const withModelChip = (chip) =>
				modelChip === null ? chip : h(React.Fragment, null, chip, modelChip);
			if (handover !== null) {
				const phaseKey =
					handover.phase === 'backup'
						? 'handoverPhaseBackup'
						: handover.phase === 'continuation'
							? 'handoverPhaseContinuation'
							: 'handoverPhaseCompacting';
				const seconds = Math.max(
					0,
					Math.round((Date.now() - (handover.at ?? Date.now())) / 1000),
				);
				const status = h(
					'span',
					{
						title: `${t('handoverActiveTip')}（${seconds}s）`,
						role: 'status',
						'data-dsh-switchman': 'handover-active',
						style: {
							borderRadius: 'var(--dsw-radius-xs)',
							background: 'var(--dsw-alias-interactive-bg-hover, transparent)',
							color: 'var(--dsw-alias-state-business-primary, inherit)',
							height: '22px',
							whiteSpace: 'nowrap',
							display: 'inline-flex',
							alignItems: 'center',
							gap: '4px',
							padding: '0 8px',
							fontSize: '12px',
							lineHeight: '22px',
							flex: 'none',
						},
					},
					h(HandoverSpinner, null),
					h('span', null, `${t('handoverActive')} · ${t(phaseKey)}`),
				);
				return withModelChip(status);
			}
			const text = t('badge');
			const tip = t('badgeTip');
			const status = h(
				'span',
				{
					title: tip,
					'data-dsh-switchman': 'team-autonomy',
					style: {
						borderRadius: 'var(--dsw-radius-xs)',
						// NOTE: --dsw-alias-fill-tsp-secondary (used by the shipped preset
						// chip) is a dangling reference — no --dsw-alias-fill-* family exists
						// in the theme alias tables, so it silently computes to transparent.
						// Use the real hover-fill alias (defined for both light and dark).
						background: 'var(--dsw-alias-interactive-bg-hover, transparent)',
						height: '22px',
						color: 'var(--dsw-alias-label-tertiary)',
						whiteSpace: 'nowrap',
						display: 'inline-flex',
						alignItems: 'center',
						gap: '4px',
						padding: '0 8px',
						fontSize: '12px',
						lineHeight: '22px',
						flex: 'none',
					},
				},
				h('span', { 'aria-hidden': true, style: { flex: 'none' } }, '⚡'),
				h('span', null, text),
			);
			return withModelChip(status);
		}

		/** Composer-dock vision entry. Two jobs:
		 *
		 * 1. Guidance chip — DSH refuses to send pasted images while the
		 *    session model has no image input; switchman's unlock is the
		 *    /vision command backed by the vision pool. The chip renders
		 *    whenever image support is not positively confirmed (probe
		 *    false, or null = unresolved — the common live case: the
		 *    Host-side model-info resolution often cannot resolve custom
		 *    routes), polling the Host route at a slow fixed cadence;
		 *    any failure renders nothing.
		 * 2. Reactive auto-conversion (v1) — when a plain send is refused
		 *    host-side (session/attachment-invalid), rewrite the draft as
		 *    "/vision <original text>" and resubmit once; the claimed
		 *    command submit carries the restored draft attachments past
		 *    the model gate to the /vision handler. The refusal code is
		 *    the authoritative image-gate signal; the probe's
		 *    imageCapable only brakes the conversion when it positively
		 *    says true. Session-scoped dock entries receive the standard
		 *    kit (inputActions, useInput, useSession) automatically;
		 *    loop safety = one conversion per promptError object
		 *    identity + never converting a draft that already starts
		 *    with "/". */
		function VisionDockEntry({ t, sessionId, inputActions, useInput, useSession }) {
			const [vision, setVision] = React.useState(null);
			const [notice, setNotice] = React.useState(false);
			const handled = React.useRef(null);
			const latest = React.useRef({ vision: null, draft: '', attachmentIds: [] });
			React.useEffect(() => {
				let stopped = false;
				let timer = null;
				// The probe must judge the CURRENT conversation's model: pass
				// the session scope's identity so the Host resolves
				// imageCapable from that session's model selection (subagent
				// sessions included); without it the Host falls back to the
				// root session and mislabels text-only children. Restarting
				// the loop on `sessionId` re-probes immediately on a switch.
				const query =
					typeof sessionId === 'string' && sessionId !== ''
						? `?session=${encodeURIComponent(sessionId)}`
						: '';
				const tick = async () => {
					let next = null;
					try {
						const reply = await api.get(`vision-state${query}`);
						if (reply?.ok && reply.value && typeof reply.value === 'object')
							next = {
								poolConfigured: reply.value.poolConfigured === true,
								imageCapable: reply.value.imageCapable,
							};
					} catch {
						next = null;
					}
					if (stopped) return;
					setVision(next);
					timer = setTimeout(tick, 15_000);
				};
				void tick();
				return () => {
					stopped = true;
					if (timer !== null) clearTimeout(timer);
				};
			}, [sessionId]);
			// Standard kit props are guaranteed by the session scope, but the
			// hooks must be called unconditionally — degrade to no-op sources
			// if a future shell ever mounts this entry outside that scope.
			const inputHook =
				typeof useInput === 'function' ? useInput : () => () => ({ draft: '', attachmentIds: [] });
			const sessionHook =
				typeof useSession === 'function' ? useSession : () => () => null;
			const input = inputHook((s) => s) ?? {};
			const promptError = sessionHook((s) => s.promptError);
			latest.current = {
				vision,
				draft: typeof input.draft === 'string' ? input.draft : '',
				attachmentIds: Array.isArray(input.attachmentIds) ? input.attachmentIds : [],
			};
			React.useEffect(() => {
				if (promptError == null || promptError === handled.current) return;
				handled.current = promptError;
				if (promptError.op !== 'send') return; // stop failures are not ours
				const code = promptError.error?.code;
				if (code !== 'session/attachment-invalid' && code !== 'subagent/attachment-invalid') return;
				// Let InputBar's failure restore of the draft and attachments
				// land before reading them.
				const timer = setTimeout(() => {
					const snap = latest.current;
					// The refusal code below is the authoritative image-gate
					// signal; vision.imageCapable is only a secondary brake.
					// The Host probe legitimately yields null (unknown) when
					// its model-info resolution fails, so skip ONLY when the
					// probe positively says the model reads images.
					if (snap.vision?.imageCapable === true) return;
					const text = snap.draft.trim();
					if (text.startsWith('/')) return; // already a command path — never loop
					if (snap.attachmentIds.length === 0) return;
					if (typeof inputActions?.setDraft !== 'function' || typeof inputActions?.submit !== 'function')
						return;
					inputActions.setDraft(text === '' ? '/vision' : `/vision ${text}`);
					inputActions.submit();
					setNotice(true);
					setTimeout(() => setNotice(false), 6_000);
				}, 300);
				return () => clearTimeout(timer);
			}, [promptError, inputActions]);
			if (vision === null && !notice) return null;
			// The dock zone spans the full conversation width while the
			// composer card is a centered column (max-width contract). The
			// hero state narrows the whole stack, the active state does
			// not — so a bare <p> lands hard against the far left once a
			// conversation starts. Mirror the shell's own QueueDock column
			// formula (same CSS custom properties) to keep every line's
			// left edge tracking the input card in both states; fallback
			// values degrade to the shell defaults if a variable is unset.
			const dockColumnStyle = {
				boxSizing: 'border-box',
				width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px))',
				maxWidth: 'var(--dsh-composer-card-max-width, 780px)',
				margin: '0 auto',
				flex: 'none',
				// Keep the rhythm between the notice and hint lines equal to
				// the composer stack gap they no longer participate in.
				display: 'flex',
				flexDirection: 'column',
				gap: 'var(--dsh-composer-stack-gap, 6px)',
			};
			return h(
				'div',
				{
					'data-dsh-switchman': 'vision-dock-column',
					style: dockColumnStyle,
				},
				notice
					? h(
							'p',
							{
								'data-dsh-switchman': 'vision-auto-converted',
								style: {
									margin: '0',
									padding: '2px 0',
									color: 'var(--dsw-alias-label-secondary)',
									fontSize: '12px',
									lineHeight: '1.6',
								},
							},
							'↻ ',
							t('visionAutoConverted'),
						)
					: null,
				// Hint whenever the probe cannot positively confirm image
				// input — false (confirmed text-only) or null (unresolved,
				// the common live case): /vision is harmless either way and
				// this chip is the only composer-surface affordance for it.
				vision !== null && vision.imageCapable !== true
					? h(
							'p',
							{
								'data-dsh-switchman': 'vision-hint',
								style: {
									margin: '0',
									padding: '2px 0',
									color: 'var(--dsw-alias-label-tertiary)',
									fontSize: '12px',
									lineHeight: '1.6',
								},
							},
							'⚠ ',
							t(vision.poolConfigured ? 'visionHintUseVision' : 'visionHintNeedsPool'),
						)
					: null,
			);
		}

		/** Home-sidebar panel icon (sidebar.panellist contract): the shell
		 * row renderer passes { size, active } and colors the glyph via the
		 * row's currentColor, so only size matters here. 16×16 stroke
		 * glyph — one dispatch stem splitting into two routed lanes.
		 * data-dsh-panel-entry is the documented L2 skins hook (the shell
		 * row itself carries no per-entry marker). */
		function SwitchmanPanelIcon({ size }) {
			return h(
				'svg',
				{
					'data-dsh-panel-entry': 'dsh-switchman',
					viewBox: '0 0 16 16',
					width: size,
					height: size,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.3,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
				},
				h('path', { d: 'M2 8h4.5' }),
				h('path', { d: 'M6.5 8 10.5 4H12' }),
				h('path', { d: 'M6.5 8l4 4H12' }),
				h('path', { d: 'M12.2 2.2 14 4l-1.8 1.8' }),
				h('path', { d: 'M12.2 10.2 14 12l-1.8 1.8' }),
			);
		}

		/** Central-panel host for the sidebar entry: reuses the settings
		 * page component unchanged (its {t, locale} props arrive as the
		 * register inject() face). The main area hands the page a
		 * definite-height, overflow-clipped frame with no gutter — the
		 * page must own its scrolling (skill-explorer's .view/.tabBody
		 * pattern): height:100% scroll owner outside, reading-width
		 * centered column inside. */
		function SwitchmanPanelPage(props) {
			// Re-render when the manual interface-locale override changes
			// (panel strings go through the injected t wrapper).
			React.useSyncExternalStore(subscribeUiLocale, () => uiLocaleVersion);
			return h(
				'div',
				{
					'data-dsh-switchman': 'panel',
					style: {
						minWidth: 0,
						minHeight: 0,
						height: '100%',
						overflowY: 'auto',
					},
				},
				h(
					'div',
					{
						style: {
							minWidth: 0,
							maxWidth: '860px',
							margin: '0 auto',
							padding: '16px 24px',
							boxSizing: 'border-box',
						},
					},
					h(SwitchmanSettingsPage, props),
				),
			);
		}

		// ------------------------------------------------------------------
		// Settings page (Phase 1)
		// ------------------------------------------------------------------

		/** Shared inline-style fragments (theme aliases only, no new deps). */
		const STYLE = {
			page: { minWidth: 0, minHeight: 0 },
			section: { minWidth: 0, padding: '16px 0' },
			heading: {
				color: 'var(--dsw-alias-label-primary)',
				margin: 0,
				fontSize: '13px',
				fontWeight: 600,
				lineHeight: 1.5,
			},
			description: {
				color: 'var(--dsw-alias-label-secondary)',
				margin: '4px 0 0',
				fontSize: '12px',
				lineHeight: 1.5,
			},
			rows: { display: 'grid', gap: '16px', margin: '16px 0 0' },
			row: {
				display: 'grid',
				gridTemplateColumns: 'minmax(160px, 240px) minmax(0, 1fr)',
				gap: '12px',
				alignItems: 'start',
			},
			rowLabel: {
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '13px',
				lineHeight: 1.5,
			},
			rowHelp: {
				color: 'var(--dsw-alias-label-tertiary)',
				margin: '2px 0 0',
				fontSize: '12px',
				lineHeight: 1.5,
			},
			control: {
				font: 'inherit',
				fontSize: '13px',
				lineHeight: 1.5,
				color: 'var(--dsw-alias-label-primary)',
				background: 'transparent',
				border: '.5px solid var(--dsw-alias-border-l2)',
				borderRadius: 'var(--dsw-radius-xs)',
				padding: '4px 8px',
				minWidth: '0',
				width: 'min(280px, 100%)',
			},
			currentValue: {
				color: 'var(--dsw-alias-label-tertiary)',
				margin: '6px 0 0',
				fontSize: '12px',
				lineHeight: 1.5,
			},
			invalid: {
				color: 'var(--dsw-alias-state-error-primary)',
				margin: '6px 0 0',
				fontSize: '12px',
				lineHeight: 1.5,
			},
			footer: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: '12px',
				flexWrap: 'wrap',
				borderTop: '.5px solid var(--dsw-alias-border-l1)',
				marginTop: '20px',
				paddingTop: '12px',
			},
			message: {
				color: 'var(--dsw-alias-label-secondary)',
				margin: 0,
				fontSize: '12px',
				lineHeight: 1.5,
			},
			messageError: {
				color: 'var(--dsw-alias-state-error-primary)',
				margin: 0,
				fontSize: '12px',
				lineHeight: 1.5,
			},
			actions: { display: 'flex', gap: '8px', flex: 'none' },
			buttonBase: {
				font: 'inherit',
				fontSize: '13px',
				lineHeight: 1.5,
				padding: '4px 14px',
				borderRadius: 'var(--dsw-radius-xs)',
				border: '1px solid var(--dsw-alias-border-l2)',
				background: 'transparent',
				cursor: 'pointer',
			},
			sectionDivider: {
				borderTop: '.5px solid var(--dsw-alias-border-l1)',
			},
			progress: {
				color: 'var(--dsw-alias-label-secondary)',
				margin: '8px 0 0',
				fontSize: '12px',
				lineHeight: 1.5,
			},
			poolGrid: {
				display: 'grid',
				gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
				gap: '12px',
				margin: '16px 0 0',
			},
			poolCard: {
				border: '.5px solid var(--dsw-alias-border-l2)',
				borderRadius: 'var(--dsw-radius-md)',
				padding: '12px',
				minWidth: 0,
				display: 'grid',
				gap: '8px',
				alignContent: 'start',
			},
			poolCardTitle: {
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '13px',
				fontWeight: 600,
				lineHeight: 1.5,
			},
			poolCardDesc: {
				color: 'var(--dsw-alias-label-tertiary)',
				margin: 0,
				fontSize: '12px',
				lineHeight: 1.5,
			},
			poolActions: {
				display: 'flex',
				gap: '12px',
				flex: 'none',
			},
			linkButton: {
				font: 'inherit',
				fontSize: '12px',
				lineHeight: 1.5,
				padding: '0',
				border: 'none',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary)',
				cursor: 'pointer',
			},
			poolList: {
				maxHeight: '320px',
				overflowY: 'auto',
				display: 'grid',
				gap: '2px',
				borderTop: '.5px solid var(--dsw-alias-border-l1)',
				paddingTop: '6px',
			},
			groupHeader: {
				color: 'var(--dsw-alias-label-tertiary)',
				margin: '6px 0 2px',
				fontSize: '11px',
				fontWeight: 600,
				lineHeight: 1.5,
			},
			checkRow: {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				minWidth: 0,
				fontSize: '12.5px',
				lineHeight: 1.6,
				color: 'var(--dsw-alias-label-primary)',
				cursor: 'pointer',
			},
			checkText: {
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
			unavailableMark: {
				color: 'var(--dsw-alias-label-tertiary)',
				flex: 'none',
			},
			unauthorizedMark: {
				color: 'var(--dsw-alias-state-error-primary)',
				flex: 'none',
			},
			rankList: { display: 'grid', gap: '2px', marginTop: '8px' },
			rankRow: {
				display: 'grid',
				gridTemplateColumns: '24px minmax(0, 1fr) auto auto',
				gap: '8px',
				alignItems: 'center',
				padding: '2px 0',
			},
			rankIndex: {
				color: 'var(--dsw-alias-label-tertiary)',
				fontSize: '12px',
				fontVariantNumeric: 'tabular-nums',
				textAlign: 'right',
			},
			rankLabel: {
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '12.5px',
				lineHeight: 1.6,
				// Wrap instead of ellipsize: provider/model pairs must stay
				// fully readable in the narrow panel (the hover title remains
				// a convenience, not the only way to read the full route).
				whiteSpace: 'normal',
				wordBreak: 'break-word',
				minWidth: 0,
			},
			rankActions: { display: 'flex', gap: '4px', flex: 'none' },
			effortSelect: {
				font: 'inherit',
				fontSize: '12px',
				lineHeight: 1.5,
				padding: '1px 2px',
				borderRadius: 'var(--dsw-radius-xs)',
				border: '.5px solid var(--dsw-alias-border-l2)',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary)',
				marginLeft: '8px',
				flex: 'none',
			},
			iconButton: {
				font: 'inherit',
				fontSize: '12px',
				lineHeight: 1.5,
				padding: '1px 7px',
				borderRadius: 'var(--dsw-radius-xs)',
				border: '.5px solid var(--dsw-alias-border-l2)',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary)',
				cursor: 'pointer',
			},
			subheading: {
				color: 'var(--dsw-alias-label-primary)',
				margin: '20px 0 0',
				fontSize: '13px',
				fontWeight: 600,
				lineHeight: 1.5,
			},
			checkbox: {
				width: '16px',
				height: '16px',
				margin: '5px 0',
				accentColor: 'var(--dsw-alias-brand-primary)',
			},
		};

		/** One settings row: label + help on the left, control + status lines
		 * (current value, suggestion, validation) on the right. */
		function SettingsRow({ id, label, help, control, lines }) {
			return h(
				'div',
				{ style: STYLE.row },
				h(
					'div',
					null,
					h('label', { htmlFor: id, style: STYLE.rowLabel }, label),
					help === undefined ? null : h('p', { style: STYLE.rowHelp }, help),
				),
				h(
					'div',
					{ style: { minWidth: 0 } },
					control,
					...lines.map((line, index) =>
						h(
							'p',
							{
								key: index,
								role: 'status',
								style: line.invalid ? STYLE.invalid : STYLE.currentValue,
							},
							line.text,
						),
					),
				),
			);
		}

		/** One <option> per candidate, rendered "native (tag)". */
		function languageOptions(t, { withUnset, withCustom }) {
			const options = [];
			if (withUnset)
				options.push(
					h(
						'option',
						{ key: '', value: '' },
						withUnset === 'follow'
							? t('followConversation')
							: t('notSetAsk'),
					),
				);
			for (const language of LANGUAGES)
				options.push(
					h(
						'option',
						{ key: language.value, value: language.value },
						`${language.label} (${language.value})`,
					),
				);
			if (withCustom)
				options.push(
					h('option', { key: CUSTOM, value: CUSTOM }, t('customLanguage')),
				);
			return options;
		}

		/** One dispatch-pool card: title + positioning, select-all/clear, and a
		 * provider-grouped checkbox list of catalog candidates plus this pool's
		 * saved-but-unavailable routes. With `manual` on, the body switches to
		 * a stored-order priority list (move up/down/remove) plus an
		 * add-only checkbox list. */
		function PoolCard({
			t,
			title,
			description,
			rows,
			extras,
			routes,
			efforts,
			manual,
			editable,
			authorized,
			teamsMode,
			onToggle,
			onToggleManual,
			onSetEffort,
			onMove,
			onRemove,
			onSelectAll,
			onClear,
		}) {
			const hasCandidates = rows.length > 0 || extras.length > 0;
			/** Authorization-drift check: this route is not among the subagent
			 *  models DSH authorized for this session (authorized === null =
			 *  unknown, no mark). When enabled === false every explicit route
			 *  is rejected, so all selected routes count as drift. Team mode
			 *  only: plain subagent mode does no explicit route injection, the
			 *  badge would be meaningless. */
			const drift = (route) =>
				teamsMode === true &&
				authorized !== null &&
				(authorized.enabled === false ||
					!authorized.keys.has(routeKey(route)));
			/** ⚠ badge for drifted rows (hover/screen-reader text in
			 *  unauthorizedBadge). */
			const unauthorizedBadge = () =>
				h(
					'span',
					{
						style: STYLE.unauthorizedMark,
						title: t('unauthorizedBadge'),
						'aria-label': t('unauthorizedBadge'),
					},
					'⚠',
				);
			/** Display-name lookup: covers catalog rows and stored off-catalog rows. */
			const nameByKey = new Map(
				[...rows, ...extras]
					.filter((row) => row.header === undefined)
					.map((row) => [
						routeKey(row),
						`${row.providerName} · ${row.modelName}`,
					]),
			);
			/** Effort lookup: a configured entry's key → effort for this pool. */
			const effortByKey = new Map(
				efforts.map((entry) => [routeKey(entry), entry.effort]),
			);
			/** Effort metadata lookup: routeKey → wire reasoning.efforts (default
			 *  when absent). */
			const effortsMetaByKey = new Map(
				[...rows, ...extras]
					.filter(
						(row) =>
							row.header === undefined && Array.isArray(row.reasoning?.efforts),
					)
					.map((row) => [routeKey(row), row.reasoning.efforts]),
			);
			/** Effort dropdown options for one selected model: prefer the real
			 *  efforts from the model's wire metadata; fall back to the EFFORTS
			 *  constant when unavailable; append a stored legacy value missing
			 *  from the list so the controlled select never misaligns. */
			const effortOptions = (route) => {
				const key = routeKey(route);
				const wireEfforts = effortsMetaByKey.get(key);
				const raw =
					wireEfforts !== undefined && wireEfforts.length > 0
						? wireEfforts
						: EFFORTS.map((effort) => ({ id: effort }));
				const seen = new Set(raw.map((entry) => entry.id));
				const current = effortByKey.get(key);
				const pending =
					typeof current === 'string' && current !== '' && !seen.has(current)
						? [{ id: current }]
						: [];
				return [
					{ id: '', name: t('poolEffortFollow') },
					...raw.map((entry) => ({
						id: entry.id,
						name: entry.name ?? entry.id,
					})),
					...pending,
				];
			};
			/** Effort dropdown for one selected model ('' = follow the lane
			 *  default); stop propagation so the outer label's checkbox does not
			 *  toggle. */
			const effortSelect = (route) =>
				h(
					'select',
					{
						style: STYLE.effortSelect,
						title: t('poolEffortHelp'),
						'aria-label': `${t('poolEffortLabel')} · ${route.provider}/${route.model}`,
						disabled: !editable,
						value: effortByKey.get(routeKey(route)) ?? '',
						onClick: (e) => e.stopPropagation(),
						onChange: (e) => {
							onSetEffort(route, e.target.value);
						},
					},
					...effortOptions(route).map((option) =>
						h('option', { value: option.id }, option.name),
					),
				);
			/** Manual-mode "addable" list: unchecked catalog rows only, empty
			 *  group headers dropped. */
			const addableRows = [];
			if (manual) {
				let pendingHeader = null;
				for (const row of rows) {
					if (row.header !== undefined) {
						pendingHeader = row;
						continue;
					}
					if (row.selected) continue;
					if (pendingHeader !== null) {
						addableRows.push(pendingHeader);
						pendingHeader = null;
					}
					addableRows.push(row);
				}
			}
			/** Manual-order switch on the right of the header row. */
			const manualToggle = h(
				'label',
				{ style: STYLE.checkRow, title: t('poolManualHelp') },
				h('input', {
					type: 'checkbox',
					checked: manual,
					disabled: !editable,
					onChange: onToggleManual,
				}),
				h('span', { style: STYLE.checkText }, t('poolManualLabel')),
			);
			if (manual)
				return h(
					'div',
					{ style: STYLE.poolCard },
					h('div', { style: STYLE.poolCardTitle }, title, manualToggle),
					h('p', { style: STYLE.poolCardDesc }, description),
					routes.length > 0
						? h(
								'div',
								{ style: STYLE.poolList },
								h('p', { style: STYLE.groupHeader }, t('poolManualSelected')),
								h(
									'div',
									{ style: STYLE.rankList },
									...routes.map((route, index) =>
										h(
											'div',
											{ key: routeKey(route), style: STYLE.rankRow },
											h('span', { style: STYLE.rankIndex }, String(index + 1)),
											h(
												'span',
												{
													style: STYLE.rankLabel,
													title: `${route.provider}/${route.model}`,
												},
												nameByKey.get(routeKey(route)) ??
													`${route.provider} · ${route.model}`,
												drift(route) ? unauthorizedBadge() : null,
											),
											effortSelect(route),
											h(
												'div',
												{ style: STYLE.rankActions },
												h(
													'button',
													{
														type: 'button',
														onClick: () => {
															onMove(index, -1);
														},
														disabled: !editable || index === 0,
														title: t('poolMoveUp'),
														'aria-label': t('poolMoveUp'),
														style: STYLE.iconButton,
													},
													'↑',
												),
												h(
													'button',
													{
														type: 'button',
														onClick: () => {
															onMove(index, 1);
														},
														disabled: !editable || index === routes.length - 1,
														title: t('poolMoveDown'),
														'aria-label': t('poolMoveDown'),
														style: STYLE.iconButton,
													},
													'↓',
												),
												h(
													'button',
													{
														type: 'button',
														onClick: () => {
															onRemove(index);
														},
														disabled: !editable,
														title: t('poolRemoveOne'),
														'aria-label': t('poolRemoveOne'),
														style: STYLE.iconButton,
													},
													'✕',
												),
											),
										),
									),
								),
							)
						: h('p', { style: STYLE.poolCardDesc }, t('poolEmpty')),
					addableRows.length > 0
						? h(
								'div',
								{ style: STYLE.poolList },
								h('p', { style: STYLE.groupHeader }, t('poolManualAddable')),
								...addableRows.map((row, index) =>
									row.header !== undefined
										? h(
												'p',
												{ key: `h${index}`, style: STYLE.groupHeader },
												row.header,
											)
										: h(
												'label',
												{
													key: routeKey(row),
													style: STYLE.checkRow,
													title: `${row.provider}/${row.model}`,
												},
												h('input', {
													type: 'checkbox',
													checked: false,
													disabled: !editable,
													onChange: () => {
														onToggle(row);
													},
												}),
												h(
													'span',
													{ style: STYLE.checkText },
													`${row.providerName} · ${row.modelName}`,
												),
											),
								),
							)
						: null,
					h(
						'div',
						{ style: STYLE.poolActions },
						h(
							'button',
							{
								type: 'button',
								onClick: onClear,
								disabled: !editable,
								style: STYLE.linkButton,
							},
							t('poolClear'),
						),
					),
				);
			return h(
				'div',
				{ style: STYLE.poolCard },
				h('div', { style: STYLE.poolCardTitle }, title, manualToggle),
				h('p', { style: STYLE.poolCardDesc }, description),
				h(
					'div',
					{ style: STYLE.poolActions },
					h(
						'button',
						{
							type: 'button',
							onClick: onSelectAll,
							disabled: !editable,
							style: STYLE.linkButton,
						},
						t('poolSelectAll'),
					),
					h(
						'button',
						{
							type: 'button',
							onClick: onClear,
							disabled: !editable,
							style: STYLE.linkButton,
						},
						t('poolClear'),
					),
				),
				hasCandidates
					? h(
							'div',
							{ style: STYLE.poolList },
							...rows.map((row, index) =>
								row.header !== undefined
									? h(
											'p',
											{ key: `h${index}`, style: STYLE.groupHeader },
											row.header,
										)
									: h(
											'label',
											{
												key: routeKey(row),
												style: STYLE.checkRow,
												title: `${row.provider}/${row.model}`,
											},
											h('input', {
												type: 'checkbox',
												checked: row.selected,
												disabled: !editable,
												onChange: () => {
													onToggle(row);
												},
											}),
											h(
												'span',
												{ style: STYLE.checkText },
												`${row.providerName} · ${row.modelName}`,
											),
											...(row.selected ? [effortSelect(row)] : []),
											...(row.selected && drift(row)
												? [unauthorizedBadge()]
												: []),
										),
							),
							extras.length > 0
								? h(
										'p',
										{ key: 'extras', style: STYLE.groupHeader },
										t('catalogUnavailableGroup'),
									)
								: null,
							...extras.map((row) =>
								h(
									'label',
									{
										key: routeKey(row),
										style: STYLE.checkRow,
										title: `${row.provider}/${row.model}`,
									},
									h('input', {
										type: 'checkbox',
										checked: true,
										disabled: !editable,
										onChange: () => {
											onToggle(row);
										},
									}),
									h(
										'span',
										{ style: STYLE.checkText },
										`${row.providerName} · ${row.modelName}`,
									),
									effortSelect(row),
									h(
										'span',
										{ style: STYLE.unavailableMark },
										` · ${t('catalogUnavailable')}`,
									),
									drift(row) ? unauthorizedBadge() : null,
								),
							),
						)
					: h('p', { style: STYLE.poolCardDesc }, t('poolEmpty')),
			);
		}

		/** The dsh-switchman settings page: language preferences, dispatch
		 * pools, capability ranking, and enforcement mode — one staged draft
		 * (revision-fenced) committed through one atomic mutate, following the
		 * shipped settings pages' save/conflict model. Pool and ranking
		 * candidates come from the live model catalog, refreshed whenever the
		 * Host's adapter set changes. */
	function SwitchmanSettingsPage({ t, locale, setUiLocale }) {
		// Re-render on UI-language switches (drives t() and the suggestion).
		React.useSyncExternalStore(
			(fn) => locale.subscribe(fn),
			() => locale.getLocale(),
		);
		// Re-render when the manual interface-locale override changes or a
		// saved override is restored at startup.
		React.useSyncExternalStore(subscribeUiLocale, () => uiLocaleVersion);
		// Hooks above the availability early-returns keep a stable order.
		const headingId = React.useId();

		/** Live settings snapshot from the Host route: { status, writable,
		 *  values } — mirrors the configForms snapshot shape the page was
		 *  originally written against. */
		const [form, setForm] = React.useState({ status: 'loading', writable: false });
		/** draft: { values } | null — values hold all three fields. */
		const [draft, setDraft] = React.useState(null);
		/** Explicitly switched to the "Custom…" select entry. */
		const [customArmed, setCustomArmed] = React.useState(false);
		const [saving, setSaving] = React.useState(false);
		const [failed, setFailed] = React.useState(false);
		const [conflicted, setConflicted] = React.useState(false);
		/** Last whitelist sync status from the Host config answer: null when
		 *  both teams switches are off (the Host omits the field), otherwise
		 *  { ok, count, at, error? }. */
		const [whitelistSync, setWhitelistSync] = React.useState(null);

		// Mirror the editable state for async save flows below (setState
		// alone is too late inside stale closures).
		const draftRef = React.useRef(null);
		const savingRef = React.useRef(false);
		const saveGeneration = React.useRef(0);
		/** Values this page loaded — the optimistic-concurrency baseline the
		 *  Host route fences writes against. */
		const loadedRef = React.useRef(null);
		/** Unmount guard for the post-save sync-status re-reads. */
		const syncAlive = React.useRef(true);
		React.useEffect(() => () => {
			syncAlive.current = false;
		}, []);

		/** Re-read the config answer for the whitelist sync status line: the
		 *  Host syncs after a successful write, so one immediate and one
		 *  delayed read bracket the async window. */
		const refreshWhitelistSync = React.useCallback(async () => {
			const response = await api.get('config');
			if (!syncAlive.current || !response.ok) return;
			setWhitelistSync(response.value?.whitelistSync ?? null);
		}, []);

		const assignDraft = (next) => {
			draftRef.current = next;
			setDraft(next);
		};

		// Load the settings snapshot from the Host route on mount.
		React.useEffect(() => {
			let alive = true;
			void (async () => {
				const response = await api.get('config');
				if (!alive) return;
				if (response.ok && response.value?.values !== undefined) {
					loadedRef.current = response.value.values;
					setForm({ status: 'ready', writable: true, values: response.value.values });
					// Whitelist sync status travels beside the values (null
					// unless both teams switches are on).
					setWhitelistSync(response.value.whitelistSync ?? null);
				} else setForm({ status: 'error', writable: false });
			})();
			return () => {
				alive = false;
			};
		}, []);

		// Suppress late save settlements after unmount.
		React.useEffect(() => () => {
			saveGeneration.current += 1;
		}, []);

		// Model catalog (Phase 2): loaded once on mount from the Host
		// route (the restricted runtime has no remote service to subscribe
		// to adapter updates); generation-guarded so a stale answer cannot
		// overwrite a newer one.
		const [catalog, setCatalog] = React.useState({
			status: 'idle',
			groups: [],
			failures: 0,
		});
		const catalogGeneration = React.useRef(0);
		const loadCatalog = React.useCallback(async () => {
			const generation = ++catalogGeneration.current;
			setCatalog((previous) => ({ ...previous, status: 'loading' }));
			const response = await api.get('models');
			if (generation !== catalogGeneration.current) return;
			if (response.ok && Array.isArray(response.value?.groups))
				setCatalog({
					status: 'ready',
					groups: response.value.groups,
					failures: response.value.failures?.length ?? 0,
				});
			else setCatalog((previous) => ({ ...previous, status: 'error' }));
		}, []);
		React.useEffect(() => {
			loadCatalog();
		}, [loadCatalog]);
			const catalogIndex = indexCatalog(catalog.groups);

		// DSH-side child-model authorization (which routes this session may
		// name explicitly on subagent/workflow calls): loaded once on mount
		// beside the catalog. null (failed fetch or unreadable service)
		// means unknown — no ⚠ badges, no hint.
		const [authorized, setAuthorized] = React.useState(null);
		React.useEffect(() => {
			let alive = true;
			void (async () => {
				const response = await api.get('authorized');
				if (!alive) return;
				setAuthorized(
					response.ok ? parseAuthorized(response.value) : null,
				);
			})();
			return () => {
				alive = false;
			};
		}, []);

			// Numeric watermark editing: one raw-text overlay per field so
			// partial input ('', '5', leading zeros) is editable without
			// corrupting the draft; parseable integers commit immediately,
			// blanks/invalid text stay local but block saving. Cleared on blur
			// (display falls back to the field's draft value) and whenever the
			// draft itself is cleared.
			const [numText, setNumText] = React.useState({});
			const clearNumText = () => {
				setNumText({});
			};

			const current = readCurrent(form);
			const values = draft === null ? current : draft.values;
			const customActive =
				customArmed ||
				(values.langConversation !== '' &&
					!isCandidate(values.langConversation));
			/** Per-field numeric validity: raw text (when present) must be a
			 * whole number at or above the schema minimum. */
			const numberInvalid = Object.fromEntries(
				WM_NUMBER_FIELDS.map(({ field, min }) => {
					const raw = numText[field];
					return [
						field,
						raw !== undefined &&
							(!/^\d+$/.test(raw.trim()) || Number(raw.trim()) < min),
					];
				}),
			);
			const anyNumberInvalid = Object.values(numberInvalid).some(Boolean);
			/** Ported hard rule (opencode config.ts): strict soft < hard < force. */
			const orderInvalid =
				!(values.wmSoftTokens < values.wmHardTokens) ||
				!(values.wmHardTokens < values.wmForceTokens);
			const invalid =
				(values.langScope === 'global' &&
					customActive &&
					values.langConversation.trim() === '') ||
				anyNumberInvalid ||
				orderInvalid;
			const dirty = !sameValues(current, values);
			const available = form.status === 'ready';
			const editable = available && form.writable && !saving;

			/** Begin or extend the draft with one field write. */
			function edit(field, value) {
				if (!editable) return;
				let next = draftRef.current;
				if (next === null)
					next = { values: current };
				assignDraft({
					...next,
					values: { ...next.values, [field]: value },
				});
				setFailed(false);
			}

			/** Number-input onChange: stage the raw text, commit only whole
			 * numbers (the draft always holds parseable values). */
			function editNumber(field, raw) {
				setNumText((previous) => ({ ...previous, [field]: raw }));
				const trimmed = raw.trim();
				if (/^\d+$/.test(trimmed)) edit(field, Number(trimmed));
			}

			/** Number-input onBlur: drop the overlay so the display falls back
			 * to the (last committed or accepted) numeric value. */
			const blurNumber = (field) => () => {
				setNumText((previous) => {
					if (previous[field] === undefined) return previous;
					const next = { ...previous };
					delete next[field];
					return next;
				});
			};

			/** Conversation select: a candidate/'' write disarms custom mode. */
			function selectConversation(value) {
				if (value === CUSTOM) {
					setCustomArmed(true);
					edit('langConversation', '');
				} else {
					setCustomArmed(false);
					edit('langConversation', value);
				}
			}

			/** Toggle one route in one dispatch pool (checkbox rows). */
			function togglePool(field, meta) {
				const pool = values[field];
				const key = routeKey(meta);
				const existed = pool.some((route) => routeKey(route) === key);
				edit(
					field,
					existed
						? pool.filter((route) => routeKey(route) !== key)
						: [...pool, { provider: meta.provider, model: meta.model }],
				);
				// Unchecking a route also drops its pinned effort entry
				if (existed) {
					const { effortsField } = POOL_FIELDS.find(
						(spec) => spec.field === field,
					);
					edit(
						effortsField,
						values[effortsField].filter((entry) => routeKey(entry) !== key),
					);
				}
			}

			/** Select every listed candidate (catalog + saved extras) in one
			 * pool, or clear it. */
			function setAllPool(field, select) {
				if (!select) {
					edit(field, []);
					// Clearing a pool also clears its pinned effort entries
					const { effortsField } = POOL_FIELDS.find(
						(spec) => spec.field === field,
					);
					edit(effortsField, []);
					return;
				}
				const extras = values[field]
					.filter((route) => !catalogIndex.has(routeKey(route)))
					.map((route) => ({ provider: route.provider, model: route.model }));
				const clean = (meta) => ({ provider: meta.provider, model: meta.model });
				edit(field, [...[...catalogIndex.values()].map(clean), ...extras]);
			}

			/** Manual order: swap the route at index with its neighbor
			 *  (boundary-guarded). */
			function movePoolRoute(field, index, delta) {
				const pool = values[field];
				const target = index + delta;
				if (target < 0 || target >= pool.length) return;
				const next = [...pool];
				[next[index], next[target]] = [next[target], next[index]];
				edit(field, next.map((route) => ({
					provider: route.provider,
					model: route.model,
				})));
			}

			/** Manual order: remove the route at index. */
			function removePoolRoute(field, index) {
				const next = [...values[field]];
				const [removed] = next.splice(index, 1);
				edit(field, next.map((route) => ({
					provider: route.provider,
					model: route.model,
				})));
				// Drop the route's pinned effort entry alongside
				const { effortsField } = POOL_FIELDS.find(
					(spec) => spec.field === field,
				);
				edit(
					effortsField,
					values[effortsField].filter(
						(entry) => routeKey(entry) !== routeKey(removed),
					),
				);
			}

			/** Set/clear a route's pinned effort entry in a pool (effort '' =
			 *  remove the entry). */
			function setPoolEffort(effortsField, meta, effort) {
				const key = routeKey(meta);
				const rest = values[effortsField].filter(
					(entry) => routeKey(entry) !== key,
				);
				edit(
					effortsField,
					effort === ''
						? rest
						: [
								...rest,
								{
									provider: meta.provider,
									model: meta.model,
									effort,
								},
							],
				);
			}

			/** Apply one edit to the rank display list and persist the whole
			 * displayed order as modelRank (a WYSIWYG edit materializes the
			 * unranked tail's catalog order too — same ordering either way). */
			function editRank(mutate) {
				const display = rankDisplay(values, catalogIndex);
				mutate(display);
				edit('modelRank', rankValue(display));
			}

			/** Move the entry at `index` by `delta` rows (bounds-guarded). */
			function moveRank(index, delta) {
				editRank((display) => {
					const target = index + delta;
					if (target < 0 || target >= display.length) return;
					[display[index], display[target]] = [display[target], display[index]];
				});
			}

			/** Anchor (or clear, '') the tier of the entry at `index`. */
			function setRankTier(index, tier) {
				editRank((display) => {
					display[index] =
						tier === ''
							? { provider: display[index].provider, model: display[index].model }
							: { ...display[index], tier };
				});
			}

			/** Drop the entry at `index` from the ranking (a pool-selected
			 * model returns to the unranked tail). */
			function removeRank(index) {
				editRank((display) => {
					display.splice(index, 1);
				});
			}

		async function save() {
			if (form.status !== 'ready' || !form.writable || savingRef.current)
				return;
			const desired = {
				langScope: values.langScope,
				langConversation: values.langConversation.trim(),
				langComments: values.langComments,
				langDocs: values.langDocs,
				uiLocale: values.uiLocale,
				...Object.fromEntries(
					POOL_FIELDS.map(({ field }) => [
						field,
						values[field].map((route) => ({
							provider: route.provider,
							model: route.model,
						})),
					]),
				),
				...Object.fromEntries(
					POOL_FIELDS.map(({ manualField }) => [
						manualField,
						values[manualField],
					]),
				),
				...Object.fromEntries(
					POOL_FIELDS.map(({ effortsField }) => [
						effortsField,
						values[effortsField].map((entry) => ({
							provider: entry.provider,
							model: entry.model,
							effort: entry.effort,
						})),
					]),
				),
				modelRank: rankValue(values.modelRank),
				dispatchEnforce: values.dispatchEnforce,
				...Object.fromEntries(
					WM_NUMBER_FIELDS.map(({ field }) => [field, values[field]]),
				),
				wmDenyMode: values.wmDenyMode,
				wmAutoHandover: values.wmAutoHandover,
				wmSubagentCap: values.wmSubagentCap,
				teamsMode: values.teamsMode,
				syncWhitelist: values.syncWhitelist,
			};
			if (sameValues(current, desired)) {
				// Whitespace-only differences: nothing to write, close the draft.
				if (draftRef.current !== null) {
					assignDraft(null);
					setCustomArmed(false);
					clearNumText();
				}
				return;
			}
			const generation = ++saveGeneration.current;
			savingRef.current = true;
			setSaving(true);
			setFailed(false);
			setConflicted(false);
			let response;
			try {
				response = await api.post('config', {
					expected: loadedRef.current,
					values: desired,
				});
			} catch {
				response = { ok: false, status: 0 };
			}
			if (generation !== saveGeneration.current) return;
			savingRef.current = false;
			setSaving(false);
			if (response.ok) {
				loadedRef.current = response.value.values;
				setForm({
					status: 'ready',
					writable: true,
					values: response.value.values,
				});
				// The write triggers the whitelist sync Host-side; the answer
				// may already carry fresh status, and the delayed re-read
				// covers the async tail.
				if (response.value?.whitelistSync !== undefined)
					setWhitelistSync(response.value.whitelistSync);
				if (desired.syncWhitelist === true) {
					void refreshWhitelistSync();
					setTimeout(() => {
						void refreshWhitelistSync();
					}, 2000);
				}
				assignDraft(null);
				setCustomArmed(false);
				clearNumText();
				return;
			}
			if (response.status === 409) {
				// Settings changed outside this page (e.g. the language
				// capture): adopt the fresh values, keep the draft, flag.
				setConflicted(true);
				if (response.value?.values !== undefined) {
					loadedRef.current = response.value.values;
					setForm({
						status: 'ready',
						writable: true,
						values: response.value.values,
					});
				}
				return;
			}
			setFailed(true);
		}

			function discard() {
				if (savingRef.current) return;
				assignDraft(null);
				setCustomArmed(false);
				clearNumText();
				setFailed(false);
				setConflicted(false);
			}

			if (form.status === 'loading')
				return h(
					'p',
					{ style: STYLE.message, role: 'status' },
					t('formLoading'),
				);
			if (!available)
				return h(
					'p',
					{ style: STYLE.message, role: 'status' },
					t('formUnavailable'),
				);

			const conversationId = `${headingId}-conversation`;
			const commentsId = `${headingId}-comments`;
			const docsId = `${headingId}-docs`;
			const scopeId = `${headingId}-scope`;
			/** Project scope moves the three slots into per-project files. */
			const langLocked = values.langScope === 'project';
			const suggestion = suggestFromUiLocale(locale.getLocale().active);

			/** Status lines under one row's control. */
			const linesFor = (field) => {
				const lines = [];
				if (field === 'langConversation' && invalid)
					lines.push({ text: t('customLanguageRequired'), invalid: true });
				lines.push(
					current[field] === ''
						? {
								text:
									field === 'langConversation'
										? t('currentValueUnset')
										: t('currentValue', {
												value: t('followConversation'),
											}),
								invalid: false,
							}
						: {
								text: t('currentValue', {
									value: formatLanguage(current[field]),
								}),
								invalid: false,
							},
				);
				if (field === 'langConversation' && current.langConversation === '')
					lines.push({
						text: t('suggestedValue', {
							value: formatLanguage(suggestion),
						}),
						invalid: false,
					});
				return lines;
			};

			/** Shared select props (disabled while saving / read-only / locked). */
			const selectProps = (id, value, onChange, locked = false) => ({
				id,
				value,
				onChange: (event) => onChange(event.target.value),
				disabled: !editable || locked,
				style: STYLE.control,
			});

			const conversationControl = h(
				'div',
				{ style: { display: 'grid', gap: '6px', minWidth: 0 } },
				h(
					'select',
					selectProps(
						conversationId,
						customActive
							? CUSTOM
							: values.langConversation,
						selectConversation,
						langLocked,
					),
					...languageOptions(t, { withUnset: 'ask', withCustom: true }),
				),
				customActive
					? h('input', {
							type: 'text',
							value: values.langConversation,
							onChange: (event) =>
								edit('langConversation', event.target.value),
							placeholder: t('customLanguagePlaceholder'),
							maxLength: LANG_MAX,
							disabled: !editable || langLocked,
							'aria-label': t('customLanguage'),
							style: STYLE.control,
						})
					: null,
			);

			const saveDisabled =
				!form.writable || saving || conflicted || invalid || !dirty;

			// ---- dispatch section derived state ----
			const dispatchId = `${headingId}-dispatch`;
			const rankId = `${headingId}-rank`;
			const enforceId = `${headingId}-enforce`;
			const poolsSet = POOL_FIELDS.filter(
				({ field }) => values[field].length > 0,
			).length;
			const enforceLabelKey = {
				off: 'enforceOff',
				advice: 'enforceAdvice',
				enforce: 'enforceEnforce',
			};
			const enforceHelpKey = {
				off: 'enforceHelpOff',
				advice: 'enforceHelpAdvice',
				enforce: 'enforceHelpEnforce',
			};
			const display = rankDisplay(values, catalogIndex);
			// Teams mode (draft value, consistent with the rest of the page):
			// gates the ⚠ authorization badges/hint — plain subagent dispatch
			// names no explicit routes, so drift marks would be noise.
			const teamsMode = values.teamsMode === true;
			/** Authorization drift exists when at least one selected pool
			 *  route is outside the DSH-authorized child models (or the
			 *  whitelist is readable and explicit selection is disabled
			 *  while any pool is configured) — drives the section hint.
			 *  Teams mode only (see above). */
			const anyUnauthorized =
				teamsMode &&
				authorized !== null &&
				(authorized.enabled === false
					? poolsSet > 0
					: POOL_FIELDS.some(({ field }) =>
							values[field].some(
								(route) => !authorized.keys.has(routeKey(route)),
							),
						));

			// ---- watermark section derived state ----
			const wmId = `${headingId}-wm`;
			// ---- teams section ids ----
			const teamsId = `${headingId}-teams`;

			/** One watermark number input: raw-text overlay over the draft
			 * value (0 renders as the placeholder for the follow-force row),
			 * red border while the raw text fails its minimum. */
			const wmNumberControl = (spec, placeholder) => {
				const { field } = spec;
				const shown =
					numText[field] ??
					(values[field] === 0 && placeholder !== undefined
						? ''
						: String(values[field]));
				return h('input', {
					type: 'text',
					inputMode: 'numeric',
					id: `${wmId}-${field}`,
					value: shown,
					placeholder,
					onChange: (event) => {
						editNumber(field, event.target.value);
					},
					onBlur: blurNumber(field),
					disabled: !editable,
					'aria-label': t(WM_ROW_KEYS[field].label),
					style: numberInvalid[field]
						? {
								...STYLE.control,
								borderColor: 'var(--dsw-alias-state-error-primary)',
								color: 'var(--dsw-alias-state-error-primary)',
							}
						: STYLE.control,
				});
			};

			/** Status lines under one number row: minimum + order hints. */
			const wmNumberLines = (spec) => {
				const lines = [];
				if (numberInvalid[spec.field])
					lines.push({
						text: t('wmNumberInvalid', { min: spec.min }),
						invalid: true,
					});
				if (orderInvalid && WM_ORDER_FIELDS.includes(spec.field))
					lines.push({ text: t('wmOrderInvalid'), invalid: true });
				return lines;
			};

			/** Catalog status line: loading / error + retry / partial / empty. */
			const catalogNotice =
				catalog.status === 'loading'
					? h(
							'p',
							{ key: 'loading', role: 'status', style: STYLE.progress },
							t('catalogLoading'),
						)
					: catalog.status === 'error'
						? h(
								'div',
								{
									key: 'error',
									role: 'alert',
									style: { display: 'flex', gap: '12px', marginTop: '8px' },
								},
								h('span', { style: STYLE.messageError }, t('catalogLoadFailed')),
								h(
									'button',
									{
										type: 'button',
										onClick: loadCatalog,
										disabled: saving,
										style: STYLE.linkButton,
									},
									t('catalogRetry'),
								),
							)
						: catalog.status === 'ready' && catalog.failures > 0
							? h(
									'p',
									{ key: 'partial', style: STYLE.progress },
									t('catalogPartial'),
								)
							: catalog.status === 'ready' && catalogIndex.size === 0
								? h(
										'p',
										{ key: 'empty', style: STYLE.progress },
										t('catalogEmpty'),
									)
								: null;

			/** Keys of every route configured across the six pools: the drift
			 *  badge is pool-scoped, so rank-only modelRank entries (in no
			 *  pool) never carry it. */
			const poolRouteKeys = new Set(
				POOL_FIELDS.flatMap(({ field }) => values[field].map(routeKey)),
			);
			/** Pool-scoped drift check for rank rows (same semantics as the
			 *  PoolCard drift helper, which is not in scope here). Teams mode
			 *  only, matching the pool cards. */
			const rankDrift = (route) =>
				teamsMode === true &&
				authorized !== null &&
				(authorized.enabled === false ||
					!authorized.keys.has(routeKey(route)));
			/** One ranking row: index, label, tier select, move/remove buttons. */
			const rankRow = (entry, index) => {
				const key = routeKey(entry);
				const meta = catalogIndex.get(key);
				const up = t('rankMoveUp');
				const down = t('rankMoveDown');
				const remove = t('rankRemove');
				return h(
					'div',
					{ key, style: STYLE.rankRow },
					h('span', { style: STYLE.rankIndex }, String(index + 1)),
					h(
						'span',
						{
							style: STYLE.rankLabel,
							title: `${entry.provider}/${entry.model}`,
						},
						`${meta?.providerName ?? entry.provider} · ${meta?.modelName ?? entry.model}`,
						meta === undefined
							? h(
									'span',
									{ style: STYLE.unavailableMark },
									` · ${t('catalogUnavailable')}`,
								)
							: null,
						poolRouteKeys.has(key) && rankDrift(entry)
							? h(
									'span',
									{
										style: STYLE.unauthorizedMark,
										title: t('unauthorizedBadge'),
										'aria-label': t('unauthorizedBadge'),
									},
									'⚠',
								)
							: null,
					),
					h(
						'select',
						{
							value: entry.tier ?? '',
							onChange: (event) => {
								setRankTier(index, event.target.value);
							},
							disabled: !editable,
							'aria-label': t('rankTier'),
							style: { ...STYLE.control, width: 'auto', justifySelf: 'start' },
						},
						['', ...TIERS].map((tier) =>
							h(
								'option',
								{ key: tier, value: tier },
								tier === '' ? t('rankTierNone') : tier,
							),
						),
					),
					h(
						'div',
						{ style: STYLE.rankActions },
						h(
							'button',
							{
								type: 'button',
								onClick: () => {
									moveRank(index, -1);
								},
								disabled: !editable || index === 0,
								title: up,
								'aria-label': up,
								style: STYLE.iconButton,
							},
							'↑',
						),
						h(
							'button',
							{
								type: 'button',
								onClick: () => {
									moveRank(index, 1);
								},
								disabled: !editable || index === display.length - 1,
								title: down,
								'aria-label': down,
								style: STYLE.iconButton,
							},
							'↓',
						),
						h(
							'button',
							{
								type: 'button',
								onClick: () => {
									removeRank(index);
								},
								disabled: !editable,
								title: remove,
								'aria-label': remove,
								style: STYLE.iconButton,
							},
							'✕',
						),
					),
				);
			};

			const uiHeadingId = React.useId();
			const uiSelectId = React.useId();
			return h(
				'div',
				{ 'data-dsh-switchman': 'settings', style: STYLE.page },
				h('p', { style: STYLE.description }, t('settingsDescription')),
				h(
					'section',
					{ 'aria-labelledby': uiHeadingId, style: STYLE.section },
					h('h3', { id: uiHeadingId, style: STYLE.heading }, t('uiSectionTitle')),
					h('p', { style: STYLE.description }, t('uiSectionDescription')),
					h(
						'div',
						{ style: STYLE.rows },
						h(SettingsRow, {
							key: 'ui-locale',
							id: uiSelectId,
							lines: [],
							label: t('uiLocaleLabel'),
							help: t('uiLocaleHelp'),
							control: h(
								'select',
								selectProps(uiSelectId, values.uiLocale ?? 'auto', (value) => {
									edit('uiLocale', value);
									setUiLocale?.(value);
								}),
									...UI_LOCALE_OPTIONS.map((option) =>
										h(
											'option',
											{ key: option.value, value: option.value },
											option.value === 'auto' ? t('uiLocaleAuto') : option.label,
										),
									),
								),
							}),
						),
				),
				h(
					'section',
					{ 'aria-labelledby': headingId, style: STYLE.section },
					h(
						'h3',
						{ id: headingId, style: STYLE.heading },
						t('langSectionTitle'),
					),
					h(
						'p',
						{ style: STYLE.description },
						t('langSectionDescription'),
					),
					h(
						'div',
						{ style: STYLE.rows },
						h(
							SettingsRow,
							{
								key: 'scope',
								id: scopeId,
								label: t('langScopeLabel'),
								help: t('langScopeHelp'),
								control: h(
									'select',
									selectProps(scopeId, values.langScope, (value) =>
										edit('langScope', value),
									),
									h(
										'option',
										{ key: 'global', value: 'global' },
										t('langScopeGlobal'),
									),
									h(
										'option',
										{ key: 'project', value: 'project' },
										t('langScopeProject'),
									),
								),
								lines: langLocked
									? [{ text: t('langProjectNote'), invalid: false }]
									: [],
							},
						),
						h(
							SettingsRow,
							{
								key: 'conversation',
								id: conversationId,
								label: t('langConversationLabel'),
								help: t('langConversationHelp'),
								control: conversationControl,
								lines: linesFor('langConversation'),
							},
						),
						h(
							SettingsRow,
							{
								key: 'comments',
								id: commentsId,
								label: t('langCommentsLabel'),
								help: t('langCommentsHelp'),
								control: h(
									'select',
									selectProps(
										commentsId,
										values.langComments,
										(value) => edit('langComments', value),
										langLocked,
									),
									...languageOptions(t, { withUnset: 'follow' }),
								),
								lines: linesFor('langComments'),
							},
						),
						h(
							SettingsRow,
							{
								key: 'docs',
								id: docsId,
								label: t('langDocsLabel'),
								help: t('langDocsHelp'),
								control: h(
									'select',
									selectProps(
										docsId,
										values.langDocs,
										(value) => edit('langDocs', value),
										langLocked,
									),
									...languageOptions(t, { withUnset: 'follow' }),
								),
								lines: linesFor('langDocs'),
							},
						),
					),
				),
				h(
					'section',
					{
						'aria-labelledby': dispatchId,
						style: { ...STYLE.section, ...STYLE.sectionDivider },
					},
					h(
						'h3',
						{ id: dispatchId, style: STYLE.heading },
						t('dispatchSectionTitle'),
					),
					h(
						'p',
						{ style: STYLE.description },
						t('dispatchSectionDescription'),
					),
					h(
						'p',
						{ style: STYLE.progress },
						t('dispatchProgress', {
							pools: poolsSet,
							ranked: display.length,
							mode: t(enforceLabelKey[values.dispatchEnforce]),
						}),
					),
					catalogNotice,
					anyUnauthorized
						? h(
								'p',
								{ key: 'unauthorized', role: 'status', style: STYLE.progress },
								t('unauthorizedHint'),
							)
						: null,
					h(
						'div',
						{ style: STYLE.poolGrid },
						...POOL_FIELDS.map(({ field, manualField, effortsField, lane }) => {
							const { rows, extras } = poolRows(values[field], catalogIndex);
							return h(PoolCard, {
								key: field,
								t,
								title: t(`pool${lane[0].toUpperCase()}${lane.slice(1)}Title`),
								description: t(
									`pool${lane[0].toUpperCase()}${lane.slice(1)}Desc`,
								),
								rows,
								extras,
								routes: values[field],
								efforts: values[effortsField],
								manual: values[manualField],
								editable,
								authorized,
								teamsMode,
								onToggle: (meta) => {
									togglePool(field, meta);
								},
								onToggleManual: () => {
									edit(manualField, !values[manualField]);
								},
								onSetEffort: (meta, effort) => {
									setPoolEffort(effortsField, meta, effort);
								},
								onMove: (index, delta) => {
									movePoolRoute(field, index, delta);
								},
								onRemove: (index) => {
									removePoolRoute(field, index);
								},
								onSelectAll: () => {
									setAllPool(field, true);
								},
								onClear: () => {
									setAllPool(field, false);
								},
							});
						}),
					),
					h(
						'h4',
						{ id: rankId, style: STYLE.subheading },
						t('rankTitle'),
					),
					h('p', { style: STYLE.description }, t('rankDescription')),
					display.length > 0
						? h('div', { style: STYLE.rankList }, ...display.map(rankRow))
						: h('p', { style: STYLE.progress }, t('rankEmpty')),
					h(
						'h4',
						{ style: STYLE.subheading },
						t('enforceLabel'),
					),
					h(SettingsRow, {
						key: 'enforce',
						id: enforceId,
						label: t('enforceLabel'),
						control: h(
							'select',
							selectProps(enforceId, values.dispatchEnforce, (mode) => {
								if (ENFORCE_MODES.includes(mode)) edit('dispatchEnforce', mode);
							}),
							...ENFORCE_MODES.map((mode) =>
								h(
									'option',
									{ key: mode, value: mode },
									t(enforceLabelKey[mode]),
								),
							),
						),
						lines: [
							{
								text: t(enforceHelpKey[values.dispatchEnforce]),
								invalid: false,
							},
						],
					}),
				),
				h(
					'section',
					{
						'aria-labelledby': wmId,
						style: { ...STYLE.section, ...STYLE.sectionDivider },
					},
					h('h3', { id: wmId, style: STYLE.heading }, t('wmSectionTitle')),
					h('p', { style: STYLE.description }, t('wmSectionDescription')),
					h(
						'div',
						{ style: STYLE.rows },
						...WM_NUMBER_FIELDS.filter(
							({ field }) => field !== 'wmSubagentForceTokens',
						).map((spec) =>
							h(SettingsRow, {
								key: spec.field,
								id: `${wmId}-${spec.field}`,
								label: t(WM_ROW_KEYS[spec.field].label),
								help: t(WM_ROW_KEYS[spec.field].help),
								control: wmNumberControl(spec),
								lines: wmNumberLines(spec),
							}),
						),
						h(SettingsRow, {
							key: 'wmDenyMode',
							id: `${wmId}-deny`,
							label: t('wmDenyModeLabel'),
							control: h(
								'select',
								selectProps(`${wmId}-deny`, values.wmDenyMode, (mode) => {
									if (mode === 'cap' || mode === 'deny')
										edit('wmDenyMode', mode);
								}),
								h('option', { key: 'cap', value: 'cap' }, t('wmDenyModeCap')),
								h('option', { key: 'deny', value: 'deny' }, t('wmDenyModeDeny')),
							),
							lines: [
								{
									text: t(
										values.wmDenyMode === 'deny'
											? 'wmDenyModeHelpDeny'
											: 'wmDenyModeHelpCap',
									),
									invalid: false,
								},
							],
						}),
						h(SettingsRow, {
							key: 'wmAutoHandover',
							id: `${wmId}-auto`,
							label: t('wmAutoHandoverLabel'),
							help: t('wmAutoHandoverHelp'),
							control: h('input', {
								type: 'checkbox',
								id: `${wmId}-auto`,
								checked: values.wmAutoHandover,
								onChange: () => {
									edit('wmAutoHandover', !values.wmAutoHandover);
								},
								disabled: !editable,
								style: STYLE.checkbox,
							}),
							lines: [],
						}),
					),
					h('h4', { style: STYLE.subheading }, t('wmSubagentTitle')),
					h(
						'div',
						{ style: STYLE.rows },
						h(SettingsRow, {
							key: 'wmSubagentCap',
							id: `${wmId}-subcap`,
							label: t('wmSubagentCapLabel'),
							help: t('wmSubagentCapHelp'),
							control: h('input', {
								type: 'checkbox',
								id: `${wmId}-subcap`,
								checked: values.wmSubagentCap,
								onChange: () => {
									edit('wmSubagentCap', !values.wmSubagentCap);
								},
								disabled: !editable,
								style: STYLE.checkbox,
							}),
							lines: [],
						}),
						h(SettingsRow, {
							key: 'wmSubagentForceTokens',
							id: `${wmId}-subforce`,
							label: t('wmSubagentForceLabel'),
							help: t('wmSubagentForceHelp'),
							control: wmNumberControl(
								WM_NUMBER_FIELDS.find(
									({ field }) => field === 'wmSubagentForceTokens',
								),
								t('wmSubagentFollowForce'),
							),
							lines: wmNumberLines(
								WM_NUMBER_FIELDS.find(
									({ field }) => field === 'wmSubagentForceTokens',
								),
							),
						}),
					),
					h('p', { style: STYLE.progress }, t('wmCommands')),
				),
				h(
					'section',
					{
						'aria-labelledby': teamsId,
						style: { ...STYLE.section, ...STYLE.sectionDivider },
					},
					h(
						'h3',
						{ id: teamsId, style: STYLE.heading },
						t('teamsSectionTitle'),
					),
					h(
						'p',
						{ style: STYLE.description },
						t('teamsSectionDescription'),
					),
					h(
						'div',
						{ style: STYLE.rows },
						h(SettingsRow, {
							key: 'teamsMode',
							id: `${teamsId}-mode`,
							label: t('teamsModeLabel'),
							help: t('teamsModeHelp'),
							control: h('input', {
								type: 'checkbox',
								id: `${teamsId}-mode`,
								checked: values.teamsMode,
								onChange: () => {
									edit('teamsMode', !values.teamsMode);
								},
								disabled: !editable,
								style: STYLE.checkbox,
							}),
							lines: [],
						}),
						h(SettingsRow, {
							key: 'syncWhitelist',
							id: `${teamsId}-sync`,
							label: t('syncWhitelistLabel'),
							help: t('syncWhitelistHelp'),
							control: h('input', {
								type: 'checkbox',
								id: `${teamsId}-sync`,
								checked: values.syncWhitelist,
								onChange: () => {
									edit('syncWhitelist', !values.syncWhitelist);
								},
								disabled: !editable,
								style: STYLE.checkbox,
							}),
							// Status line reads the Host-reported sync state;
							// visible whenever the (independent) sync switch
							// is on — the only shape the Host reports for.
							lines:
								values.syncWhitelist === true
									? [
											whitelistSync == null
												? {
														text: t('whitelistSyncPending'),
														invalid: false,
													}
												: whitelistSync.ok === true
													? {
															text: t('whitelistSyncOk', {
																count: whitelistSync.count ?? 0,
																time:
																	typeof whitelistSync.at ===
																		'number' &&
																	whitelistSync.at > 0
																		? new Date(
																				whitelistSync.at,
																			).toLocaleString()
																		: '—',
															}),
															invalid: false,
														}
													: {
															text: t('whitelistSyncError', {
																error:
																	typeof whitelistSync.error ===
																		'string' &&
																	whitelistSync.error !== ''
																		? whitelistSync.error
																		: 'unknown',
															}),
															invalid: true,
														},
										]
									: [],
						}),
					),
					teamsMode
						? h('p', { style: STYLE.progress }, t('whitelistSyncNote'))
						: null,
				),
				h(
					'div',
					{ style: STYLE.footer },
					h(
						'p',
						{
							role: 'status',
							style: failed ? STYLE.messageError : STYLE.message,
						},
						failed
							? t('saveFailed')
							: conflicted
								? t('saveConflict')
								: saving
									? t('saving')
									: !form.writable
										? t('formReadOnly')
										: '',
					),
					form.writable
						? h(
								'div',
								{ style: STYLE.actions },
								draft === null && !failed && !conflicted
									? null
									: h(
											'button',
											{
												type: 'button',
												onClick: discard,
												disabled: saving,
												style: {
													...STYLE.buttonBase,
													color: 'var(--dsw-alias-label-secondary)',
												},
											},
											t('discard'),
										),
								h(
									'button',
									{
										type: 'button',
										onClick: save,
										disabled: saveDisabled,
										style: {
											...STYLE.buttonBase,
											color: 'var(--dsw-alias-brand-primary)',
											borderColor: 'var(--dsw-alias-brand-primary)',
											opacity: saveDisabled ? 0.5 : 1,
											cursor: saveDisabled ? 'default' : 'pointer',
										},
									},
									saving ? t('saving') : t('save'),
								),
							)
						: null,
				),
			);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, DICTS));
				const baseT = ctx.locale.bind(NS);
				// Manual interface-locale override: "auto" keeps following the
				// DSH app language (baseT); any other value resolves this
				// plugin's own strings from DICTS (zh/en) or the inline
				// EXTRA_UI_DICTS table. Every failure path degrades back to
				// baseT — never a hard error.
				let uiLocale = 'auto';
				const formatUiValue = (text, params) =>
					typeof params === 'object' && params !== null
						? text.replace(/\{(\w+)\}/g, (match, name) =>
							name in params ? String(params[name]) : match,
						)
					: text;
				const warnedUiTags = new Set();
				const dictForUiLocale = (tag) => {
					if (tag === 'en' || tag === 'zh') return DICTS[tag];
					const dict = EXTRA_UI_DICTS[tag];
					if (dict === undefined && !warnedUiTags.has(tag)) {
						warnedUiTags.add(tag);
						console.warn('[dsh-switchman] no inline UI dictionary for locale', tag);
					}
					return dict ?? null;
				};
				const t = (key, params) => {
					if (uiLocale !== 'auto') {
						const text = dictForUiLocale(uiLocale)?.[key];
						if (typeof text === 'string') return formatUiValue(text, params);
					}
					return baseT(key, params);
				};
				/** Apply an interface-locale choice immediately (preview
				 * before the settings write lands) and wake every subscribed
				 * component. All dictionaries are inline, so the switch
				 * paints on the next render — no async gap. */
				const applyUiLocale = (tag) => {
					if (tag === uiLocale) return;
					uiLocale = tag;
					notifyUiLocale();
				};
				// Report the active UI locale to the host half (it decides the
				// question language for the language-preference prompt;
				// fire-and-forget, silent on failure — the host falls back to
				// the settings' locale.preference, then to English). One extra
				// report after 3s covers the startup window where the host
				// routes become ready after this page.
				const reportUiLocale = () =>
					void api.post('ui-locale', {
						locale:
							uiLocale !== 'auto'
								? uiLocale
								: ctx.locale?.getLocale?.().active ?? '',
					});
				reportUiLocale();
				setTimeout(reportUiLocale, 3000);
				// Pick up a saved interface-locale override at startup so the
				// badge and panels already render in it without a settings
				// visit. Fail-open: any error keeps the DSH app language.
				void (async () => {
					try {
						const reply = await api.get('config');
						const tag = reply.value?.values?.uiLocale;
						if (reply.ok && typeof tag === 'string' && tag !== 'auto' && tag !== '') {
							applyUiLocale(tag);
							// The override may have landed after the initial
							// report went out; re-report the effective locale
							// so the host prompt language matches what the
							// user actually sees.
							reportUiLocale();
						}
					} catch {
						/* fail-open: keep the DSH app language */
					}
				})();
				// The session scope hands the badge the standard kit: the open
				// session's id and its live projection face (the model line),
				// plus the sessions service for the un-retained fallback.
				ctx.slots.inject('conversation.session.header.actions', () =>
					ctx.slots.register(
						{
							name: 'conversation.session.header.actions',
							id: 'dsh-switchman',
							order: -9,
						},
						(kit) =>
							h(SwitchmanBadge, {
								...kit,
								locale: ctx.locale,
								t,
							}),
					),
				);
				// Home left-sidebar entry + central panel: the same slot pair
				// the shipped Skills Center row uses. The shell owns the row
				// button, click-to-switch, active highlight, and collapsed
				// tooltip. The sidebar id and the main key must match, and
				// the inject() face becomes the page component's props
				// ({t, locale} — SwitchmanPanelPage forwards them verbatim).
				// order 31 sits directly under the Skills Center row
				// (skill-explorer 30; plugins 0, schedules 10).
				ctx.slots.inject('sidebar.panellist', () =>
					ctx.slots.register(
						{
							name: 'sidebar.panellist',
							id: 'dsh-switchman',
							order: 31,
							label: () => t('panelLabel'),
							locale: NS,
						},
						SwitchmanPanelIcon,
					),
				);
				ctx.slots.inject('main', () =>
					ctx.slots.register(
						{
							name: 'main',
							key: 'dsh-switchman',
							inject: () => ({ t, locale: ctx.locale, setUiLocale: applyUiLocale }),
						},
						SwitchmanPanelPage,
					),
				);
				// Composer-adjacent vision entry (conversation.input.dock: the
				// full-width list ABOVE the composer card): guidance chip while
				// the current session's model cannot read images, plus reactive
				// auto-conversion of refused image sends into /vision submits.
				// The session scope automatically provides
				// inputActions/useInput/useSession to the registered
				// component; the wrapper forwards that standard kit through
				// alongside the closure-bound t.
				ctx.slots.inject('conversation.input.dock', () =>
					ctx.slots.register(
						{
							name: 'conversation.input.dock',
							id: 'dsh-switchman-vision-hint',
							order: 90,
						},
						(kit) => h(VisionDockEntry, { ...kit, t }),
					),
				);
				// Settings page: one settings.section entry. The restricted
				// dynamic-module runtime has no configForms service, so there
				// is no whileServed gating — the page loads its snapshot from
				// the Host route family on mount.
				ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: 'dsh-switchman',
							order: 50,
							label: () => t('settingsTitle'),
						},
						() => h(SwitchmanSettingsPage, { t, locale: ctx.locale, setUiLocale: applyUiLocale }),
					),
				);
				// The same configuration surface on the bundle's own Plugins
				// page card (keyed by package name, rendered between the
				// bundle's description and its rows).
				ctx.slots.inject('plugins.bundle.config', () =>
					ctx.slots.register(
						{
							name: 'plugins.bundle.config',
							key: 'dsh-switchman',
						},
						() => h(SwitchmanSettingsPage, { t, locale: ctx.locale, setUiLocale: applyUiLocale }),
					),
				);
			},
		};
	}
});
