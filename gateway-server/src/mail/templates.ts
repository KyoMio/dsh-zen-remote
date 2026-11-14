// 邮件模板（纯函数，不发信）：验证码邮件与 SMTP 测试邮件的中英双语文案。
// 输出的 text 交给 smtp-client 发送，行结束符在发送时统一归一为 CRLF。
export type MailLocale = 'zh' | 'en';

export type OtpPurpose = 'signup' | 'reset_password' | 'change_email';

export interface OtpEmailInput {
  locale: MailLocale;
  purpose: OtpPurpose;
  /** 验证码本身（原样进正文） */
  code: string;
  /** 有效期（分钟） */
  ttlMinutes: number;
  /** 网关对外地址，没有就不列出这一行 */
  publicUrl?: string | null;
}

export interface SmtpTestEmailInput {
  locale: MailLocale;
  /** 网关对外地址，没有就不列出这一行 */
  publicUrl?: string | null;
  /** 发送时间（ISO 8601 字符串，原样进正文） */
  sentAtIso: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
}

const PURPOSE_ACTION_ZH: Record<OtpPurpose, string> = {
  signup: '注册新账号',
  reset_password: '重置登录密码',
  change_email: '更换账号邮箱',
};

const PURPOSE_ACTION_EN: Record<OtpPurpose, string> = {
  signup: 'sign up for a new account',
  reset_password: 'reset your login password',
  change_email: 'change the email address on your account',
};

const PURPOSE_SUBJECT_ZH: Record<OtpPurpose, string> = {
  signup: '注册验证码',
  reset_password: '密码重置验证码',
  change_email: '邮箱更换验证码',
};

const PURPOSE_SUBJECT_EN: Record<OtpPurpose, string> = {
  signup: 'signup verification code',
  reset_password: 'password reset verification code',
  change_email: 'email change verification code',
};

/** 渲染验证码邮件（注册 / 重置密码 / 更换邮箱共用一套版式） */
export function renderOtpEmail(input: OtpEmailInput): RenderedEmail {
  const { locale, purpose, code, ttlMinutes, publicUrl } = input;
  const zh = locale === 'zh';

  const subject = zh ? `您的${PURPOSE_SUBJECT_ZH[purpose]}：${code}` : `Your ${PURPOSE_SUBJECT_EN[purpose]}: ${code}`;

  const lines = zh
    ? [
        '您好，',
        '',
        `您正在${PURPOSE_ACTION_ZH[purpose]}。请使用以下验证码：`,
        '',
        code,
        '',
        `验证码有效期 ${ttlMinutes} 分钟，只能使用一次。`,
        ...(publicUrl ? ['', `所属网关：${publicUrl}`] : []),
        '',
        '如果不是您本人操作，请忽略这封邮件，也不要把验证码告诉任何人。',
      ]
    : [
        'Hello,',
        '',
        `You are about to ${PURPOSE_ACTION_EN[purpose]}. Use this verification code:`,
        '',
        code,
        '',
        `The code expires in ${ttlMinutes} minutes and can be used only once.`,
        ...(publicUrl ? ['', `Gateway: ${publicUrl}`] : []),
        '',
        "If this wasn't you, ignore this email and never share the code with anyone.",
      ];

  return { subject, text: lines.join('\n') };
}

/** 渲染 SMTP 测试邮件（管理后台「发送测试邮件」按钮） */
export function renderSmtpTestEmail(input: SmtpTestEmailInput): RenderedEmail {
  const { locale, publicUrl, sentAtIso } = input;
  const zh = locale === 'zh';

  const subject = zh ? 'SMTP 测试邮件' : 'SMTP test email';

  const lines = zh
    ? [
        '这是一封测试邮件。',
        '',
        '收到它说明 SMTP 发信配置已生效，无需进一步操作。',
        ...(publicUrl ? ['', `网关地址：${publicUrl}`] : []),
        '',
        `发送时间：${sentAtIso}`,
      ]
    : [
        'This is a test email.',
        '',
        'Receiving it means your SMTP settings are working. No further action is needed.',
        ...(publicUrl ? ['', `Gateway: ${publicUrl}`] : []),
        '',
        `Sent at: ${sentAtIso}`,
      ];

  return { subject, text: lines.join('\n') };
}
