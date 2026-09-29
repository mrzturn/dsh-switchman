/** Client half of dsh-switchman.
 *
 * Renders one static badge into `conversation.session.header.actions`
 * (order -9, immediately after the agent-preset chip at order -10): a visible
 * signal that the four built-in presets carry the autonomous Agent Teams
 * doctrine while the bundle is loaded. Styling mirrors the preset chip: theme
 * tokens only, no host package imports.
 */
window.__ModuleLoader__.load({
	id: 'dsh-switchman',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Locale-keyed copy resolved through the Client locale face. */
		const COPY = {
			zh: {
				badge: '自主团队',
				tip: 'dsh-switchman：四个内置预设（standard / ptc / minimal / cordis）已注入自主智能体团队调度规程',
			},
			en: {
				badge: 'Team autonomy',
				tip: 'dsh-switchman: the four built-in presets (standard / ptc / minimal / cordis) carry the autonomous Agent Teams doctrine',
			},
		};

		function SwitchmanBadge({ locale }) {
			// Subscription only: stable snapshot via getLocale() re-renders on switch.
			React.useSyncExternalStore(
				(fn) => locale.subscribe(fn),
				() => locale.getLocale(),
			);
			const text = locale.resolveText({
				zh: COPY.zh.badge,
				en: COPY.en.badge,
			});
			const tip = locale.resolveText({
				zh: COPY.zh.tip,
				en: COPY.en.tip,
			});
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

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.slots.inject('conversation.session.header.actions', () =>
					ctx.slots.register(
						{
							name: 'conversation.session.header.actions',
							id: 'dsh-switchman',
							order: -9,
						},
						() => h(SwitchmanBadge, { locale: ctx.locale }),
					),
				);
			},
		};
	},
});
