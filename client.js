/** Client half of dsh-switchman.
 *
 * One self-contained entry (the client-module system serves exactly one
 * bundle per package; sibling files cannot be synchronously required).
 *
 * Surfaces, all reading the shared "dsh-switchman" locale namespace (zh/en):
 * - Phase 0: the team-autonomy badge in `conversation.session.header.actions`.
 * - Phase 0: the team-autonomy badge in `conversation.session.header.actions`.
 * - Phase 1: a `settings.section` page with a "Language" card:
 *   conversation / code-comment / document language preferences.
 * - Phase 2: a "Dispatch pools & ranking" card on the same page: six lane
 *   pools and a capability ranking edited against the live model catalog
 *   (served by the Host route family), plus the enforcement mode. Every
 *   field shares one staged draft and one atomic fenced save.
 * - Phase 3: a "Context watermark" card on the same page: tiered token
 *   thresholds (soft/hard/force), the per-read budget, hard-tier behavior,
 *   automatic handover, and the subagent context cap — number inputs with
 *   per-field minimum plus soft<hard<force order validation, folded into
 *   the same staged draft and one atomic save.
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

		/** The six dispatch lanes: settings field per lane, display order. */
		const POOL_FIELDS = [
			{ field: 'poolEconomy', lane: 'economy' },
			{ field: 'poolMechanical', lane: 'mechanical' },
			{ field: 'poolMain', lane: 'main' },
			{ field: 'poolHard', lane: 'hard' },
			{ field: 'poolVision', lane: 'vision' },
			{ field: 'poolReview', lane: 'review' },
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
			'modelRank',
			'dispatchEnforce',
			...WM_NUMBER_FIELDS.map(({ field }) => field),
			'wmDenyMode',
			'wmAutoHandover',
			'wmSubagentCap',
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
			const value = snapshot.value;
			const string = (field) =>
				typeof value?.[field] === 'string' ? value[field] : '';
			const routes = (field) =>
				Array.isArray(value?.[field])
					? value[field].map(sanitizeRoute).filter(Boolean)
					: [];
			const number = ({ field, def }) =>
				typeof value?.[field] === 'number' && Number.isFinite(value[field])
					? value[field]
					: def;
			const bool = (field, def) =>
				typeof value?.[field] === 'boolean' ? value[field] : def;
			return {
				langConversation: string('langConversation'),
				langComments: string('langComments'),
				langDocs: string('langDocs'),
				...Object.fromEntries(
					POOL_FIELDS.map(({ field }) => [field, routes(field)]),
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
			};
		}

		/** Canonical serialization for equality: pools compare as sets (order
		 * inside one pool is irrelevant), the ranking as an ordered
		 * tier-annotated sequence, everything else verbatim (numbers as
		 * numbers — never their input-string forms). */
		function canonical(values) {
			return JSON.stringify({
				langConversation: values.langConversation,
				langComments: values.langComments,
				langDocs: values.langDocs,
				...Object.fromEntries(
					POOL_FIELDS.map(({ field }) => [
						field,
						values[field].map(routeKey).sort(),
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
					});
				}
			}
			return index;
		}

		/** Checkbox rows for one pool: every live catalog model, checked or
		 * not, plus this pool's saved routes that left the catalog (still
		 * removable — mirrors the shipped model-selection page). */
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
				settingsTitle: 'dsh-switchman',
				settingsDescription: '配置 dsh-switchman 的各项偏好。',
				langSectionTitle: '语言偏好',
				langSectionDescription:
					'控制智能体的对话、代码注释与文档撰写语言。',
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
				catalogLoading: '正在加载模型目录…',
				catalogLoadFailed: '无法加载模型目录。',
				catalogRetry: '重试',
				catalogPartial: '部分模型提供方暂时无法加载；已保存的选择仍可移除。',
				catalogEmpty: '当前没有模型提供方公布模型。',
				catalogUnavailableGroup: '已保存但当前不可用',
				catalogUnavailable: '当前不可用',
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
				wmSubagentCapHelp: '将子智能体的上下文限制在下方阈值内。',
				wmSubagentForceLabel: '子智能体强制阈值',
				wmSubagentForceHelp: '子智能体的强制水位；0 = 跟随上方强制水位。',
				wmSubagentFollowForce: '跟随 force 档（0）',
				wmCommands:
					'命令：/ctx-pause 暂停水位干预 · /ctx-resume 恢复干预 · /ctx-handover 立即备份并交接压缩。',
			},
			en: {
				badge: 'Team autonomy',
				badgeTip:
					'dsh-switchman: the four built-in presets (standard / ptc / minimal / cordis) carry the autonomous Agent Teams doctrine',
				settingsTitle: 'dsh-switchman',
				settingsDescription: 'Configure dsh-switchman preferences.',
				langSectionTitle: 'Language',
				langSectionDescription:
					'Controls the language of agent replies, code comments, and authored documents.',
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
				catalogLoading: 'Loading model catalog…',
				catalogLoadFailed: 'The model catalog could not be loaded.',
				catalogRetry: 'Retry',
				catalogPartial: 'Some model providers could not be loaded; saved choices remain removable.',
				catalogEmpty: 'No model provider currently advertises a model.',
				catalogUnavailableGroup: 'Saved but currently unavailable',
				catalogUnavailable: 'currently unavailable',
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
				wmSubagentCapHelp: 'Cap subagent contexts at the threshold below.',
				wmSubagentForceLabel: 'Subagent force threshold',
				wmSubagentForceHelp: 'The subagent force watermark; 0 follows the force watermark above.',
				wmSubagentFollowForce: 'Follow the force tier (0)',
				wmCommands:
					'Commands: /ctx-pause suspends watermark actions · /ctx-resume resumes them · /ctx-handover backs up and hands over now.',
			},
		};

		// ------------------------------------------------------------------
		// Session-header badge (Phase 0, unchanged)
		// ------------------------------------------------------------------

		function SwitchmanBadge({ locale, t }) {
			// Subscription only: stable snapshot via getLocale() re-renders on switch.
			React.useSyncExternalStore(
				(fn) => locale.subscribe(fn),
				() => locale.getLocale(),
			);
			const text = t('badge');
			const tip = t('badgeTip');
			return h(
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
				maxHeight: '190px',
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
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
			rankActions: { display: 'flex', gap: '4px', flex: 'none' },
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
		 * saved-but-unavailable routes. */
		function PoolCard({
			t,
			title,
			description,
			rows,
			extras,
			editable,
			onToggle,
			onSelectAll,
			onClear,
		}) {
			const hasCandidates = rows.length > 0 || extras.length > 0;
			return h(
				'div',
				{ style: STYLE.poolCard },
				h(
					'div',
					null,
					h('span', { style: STYLE.poolCardTitle }, title),
					h('p', { style: STYLE.poolCardDesc }, description),
				),
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
									h(
										'span',
										{ style: STYLE.unavailableMark },
										` · ${t('catalogUnavailable')}`,
									),
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

		// Mirror the editable state for async save flows below (setState
		// alone is too late inside stale closures).
		const draftRef = React.useRef(null);
		const savingRef = React.useRef(false);
		const saveGeneration = React.useRef(0);
		/** Values this page loaded — the optimistic-concurrency baseline the
		 *  Host route fences writes against. */
		const loadedRef = React.useRef(null);

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
				(customActive && values.langConversation.trim() === '') ||
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
				const next = pool.some((route) => routeKey(route) === key)
					? pool.filter((route) => routeKey(route) !== key)
					: [...pool, { provider: meta.provider, model: meta.model }];
				edit(field, next);
			}

			/** Select every listed candidate (catalog + saved extras) in one
			 * pool, or clear it. */
			function setAllPool(field, select) {
				if (!select) {
					edit(field, []);
					return;
				}
				const extras = values[field]
					.filter((route) => !catalogIndex.has(routeKey(route)))
					.map((route) => ({ provider: route.provider, model: route.model }));
				const clean = (meta) => ({ provider: meta.provider, model: meta.model });
				edit(field, [...[...catalogIndex.values()].map(clean), ...extras]);
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
				modelRank: rankValue(values.modelRank),
				dispatchEnforce: values.dispatchEnforce,
				...Object.fromEntries(
					WM_NUMBER_FIELDS.map(({ field }) => [field, values[field]]),
				),
				wmDenyMode: values.wmDenyMode,
				wmAutoHandover: values.wmAutoHandover,
				wmSubagentCap: values.wmSubagentCap,
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

			/** Shared select props (disabled while saving / read-only). */
			const selectProps = (id, value, onChange) => ({
				id,
				value,
				onChange: (event) => onChange(event.target.value),
				disabled: !editable,
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
							disabled: !editable,
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

			// ---- watermark section derived state ----
			const wmId = `${headingId}-wm`;

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
					h(
						'div',
						{ style: STYLE.poolGrid },
						...POOL_FIELDS.map(({ field, lane }) => {
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
								editable,
								onToggle: (meta) => {
									togglePool(field, meta);
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
				ctx.slots.inject('conversation.session.header.actions', () =>
					ctx.slots.register(
						{
							name: 'conversation.session.header.actions',
							id: 'dsh-switchman',
							order: -9,
						},
						() => h(SwitchmanBadge, { locale: ctx.locale, t }),
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
