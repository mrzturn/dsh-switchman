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

		/** 思考强度 fallback 档位（模型拿不到 wire 元数据时用）；
		 * 真实列表以 wire reasoning.efforts 为准。 */
		const EFFORTS = ['low', 'medium', 'high'];

		/** 一条格式良好的 effort 条目（{provider, model, effort}），或 null。 */
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
				// 作用域枚举（host 快照缺失/非法值一律按 global 呈现）；
				// 放在首位，与 save() 组装的 desired 键序一致，保持
				// sameValues 的无改动早退路径可用。
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
			/** 授权漂移判定：该路由不在本会话 DSH 授权的子智能体模型内
			 *  （authorized === null = 未知，不标）。enabled === false 时
			 *  一切显式指定都会被拒，所有已选路由都算漂移。仅团队模式
			 *  显示：纯 subagent 模式不做显式路由注入，徽标无意义。 */
			const drift = (route) =>
				teamsMode === true &&
				authorized !== null &&
				(authorized.enabled === false ||
					!authorized.keys.has(routeKey(route)));
			/** 漂移行的 ⚠ 徽标（悬停/读屏文案见 unauthorizedBadge）。 */
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
			/** 显示名查找：覆盖目录行与已存离架行。 */
			const nameByKey = new Map(
				[...rows, ...extras]
					.filter((row) => row.header === undefined)
					.map((row) => [
						routeKey(row),
						`${row.providerName} · ${row.modelName}`,
					]),
			);
			/** effort 查找：该池已配置条目的 key → effort。 */
			const effortByKey = new Map(
				efforts.map((entry) => [routeKey(entry), entry.effort]),
			);
			/** effort 元数据查找：routeKey → wire reasoning.efforts（无则缺省）。 */
			const effortsMetaByKey = new Map(
				[...rows, ...extras]
					.filter(
						(row) =>
							row.header === undefined && Array.isArray(row.reasoning?.efforts),
					)
					.map((row) => [routeKey(row), row.reasoning.efforts]),
			);
			/** 单个已选模型的 effort 下拉选项：优先该模型 wire 里的真实
			 * efforts；拿不到时退回 EFFORTS 常量；已存旧值不在列表里时追加，
			 * 避免受控 select 错位。 */
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
			/** 单个已选模型的 effort 下拉（'' = 跟随泳道默认）；阻止冒泡避免
			 * 触发外层 label 的 checkbox。 */
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
			/** 手动态的「可添加」列表：仅未勾选的目录行，空分组头剔除。 */
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
			/** 标题行右侧的手动序开关。 */
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
	function SwitchmanSettingsPage({ t, locale }) {
		// Re-render on UI-language switches (drives t() and the suggestion).
		React.useSyncExternalStore(
			(fn) => locale.subscribe(fn),
			() => locale.getLocale(),
		);
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
				// 取消勾选时同步移除该路由的手动 effort 条目
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
					// 清空池时同步清空该池的手动 effort 条目
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

			/** 手动序：把 index 处的路由与相邻项交换（边界守卫）。 */
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

			/** 手动序：移除 index 处的路由。 */
			function removePoolRoute(field, index) {
				const next = [...values[field]];
				const [removed] = next.splice(index, 1);
				edit(field, next.map((route) => ({
					provider: route.provider,
					model: route.model,
				})));
				// 同步移除该路由的手动 effort 条目
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

			/** 设置/清除某池某路由的手动 effort 条目（effort '' = 移除条目）。 */
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

			return h(
				'div',
				{ 'data-dsh-switchman': 'settings', style: STYLE.page },
				h('p', { style: STYLE.description }, t('settingsDescription')),
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
				const t = ctx.locale.bind(NS);
				// 报告当前生效的 UI 语言给 host 半场（决定语言询问指引的
				// 提问语言；fire-and-forget，失败静默——host 会退回
				// settings 的 locale.preference，再退回英文）。3 秒后补报
				// 一次，覆盖 host 路由晚于本页就绪的启动窗口。
				const reportUiLocale = () =>
					void api.post('ui-locale', {
						locale: ctx.locale?.getLocale?.().active ?? '',
					});
				reportUiLocale();
				setTimeout(reportUiLocale, 3000);
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
							inject: () => ({ t, locale: ctx.locale }),
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
						() => h(SwitchmanSettingsPage, { t, locale: ctx.locale }),
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
						() => h(SwitchmanSettingsPage, { t, locale: ctx.locale }),
					),
				);
			},
		};
	}
});
