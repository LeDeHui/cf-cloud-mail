import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import aiService from '../service/ai-service';
import webhookService from '../service/webhook-service';

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			webhookStatus,
			webhookUrl,
			webhookRetry,
			webhookSecret,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			console.info(`[收信] 跳过: 收件功能已关闭 to=${message.to}`);
			message.setReject('Service suspended');
			return;
		}

		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);


		const blockReason = checkBlock(blackSubject, blackContent, blackFrom, email);

		if (blockReason) {
			console.info(`[收信] 跳过: 命中黑名单(${blockReason}) to=${message.to} subject=${email.subject || ''}`);
			message.setReject('Message rejected');
			return;
		}

		let account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account) {
			const baseEmail = emailUtils.getBaseEmail(message.to);
			if (baseEmail && baseEmail !== message.to) {
				account = await accountService.selectByEmailIncludeDel({ env: env }, baseEmail);
			}
		}

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			console.info(`[收信] 跳过: 收件人不存在 to=${message.to} from=${email.from?.address || ''}`);
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				console.info(`[收信] 跳过: 收件域名无权限 to=${message.to} availDomain=${availDomain}`);
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				console.info(`[收信] 跳过: 发件人被角色禁用 from=${email.from.address} banEmail=${banEmail}`);
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';
		const code = await aiService.extractCode({ env }, email, { aiCode, aiCodeFilter });
		const fromAddress = email.from?.address || '';

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: fromAddress,
			name: email.from?.name || emailUtils.getName(fromAddress),
			senderEmail: message.from || '',
			subject: email.subject,
			code,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);

		const webhookOpen = webhookStatus === settingConst.webhookStatus.OPEN && !!webhookUrl;
		let webhookHost = '(unset)';
		try {
			if (webhookUrl) webhookHost = new URL(webhookUrl).host;
		} catch (e) {
			webhookHost = '(invalid url)';
		}
		const webhookLog = `[收信] Webhook emailId=${emailRow.emailId} status=${webhookStatus} host=${webhookHost} ruleType=${ruleType} to=${message.to}`;

		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',').map(item => item.trim());

			if (!emails.includes(message.to)) {
				console.info(`${webhookLog} 结果=被转发规则过滤`);
				return;
			}

		}

		//转发到TG
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow)
		}

		//转发到其他邮箱
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}

		//转发到 Webhook
		console.info(`${webhookLog} 结果=${webhookOpen ? '发送' : '跳过'}`);
		if (webhookOpen) {
			await webhookService.sendEmail({ env }, emailRow, webhookUrl, webhookRetry, webhookSecret);
		}

	} catch (e) {
		console.error('邮件接收异常: ', e);
		throw e
	}
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {

	const blackFromList = blackFromStr ? blackFromStr.split(',') : []
	const blackContentList = blackContentStr ? blackContentStr.split(',') : []
	const blackSubjectList = blackSubjectStr ? blackSubjectStr.split(',') : []

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return `subject:${blackSubject}`
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return `content:${blackContent}`
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return `from:${blackFrom}`
		}
	}

	return false

}
