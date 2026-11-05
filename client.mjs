window.__ModuleLoader__.load({
  id: 'dsh-gxworks',
  factory(require) {
    const { createElement } = require('react')
    const kind = 'gxworks-verification'
    return {
      inject: ['uiConversation', 'slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(kind, {
          zh: { started: '程序已生成，开始验证。将按已有规格和验收用例检查逻辑与动作时序。' },
          en: { started: 'The program is generated. Verification is starting, using the available specification and acceptance cases to check logic and timing.' },
        }))
        ctx.effect(() => ctx.uiConversation.events.register({
          kind, target: 'chat',
          match: event => event.type === 'dsh-gxworks/verification-started'
            ? { id: String(event.seq), role: 'start' } : null,
          buildViewNode(context) {
            const start = context.start
            if (!start) return null
            return { key: context.key, kind, id: context.id, target: 'chat',
              anchorSeq: start.event.seq, location: start.location, visibility: 'visible', data: {} }
          },
        }))
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node', key: kind, locale: kind,
        }, ({ t }) => createElement('p', { role: 'status' }, t('started'))))
      },
    }
  },
})
