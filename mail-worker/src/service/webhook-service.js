import domainUtils from '../utils/domain-uitls';

// 企业微信 text 消息上限约 2048 字节，留一部分余量给字段名和换行
const MAX_BYTES = 1800;

function truncate(value, maxBytes = MAX_BYTES) {
	if (value === undefined || value === null) return '';
	const bytes = new TextEncoder().encode(String(value));
	if (bytes.length <= maxBytes) return String(value);
	return new TextDecoder().decode(bytes.slice(0, maxBytes)) + '…(truncated)';
}

const webhookService = {

	async sendEmail(c, emailRow, webhookUrl, retry = 0, webhookSecret) {

		webhookUrl = domainUtils.toOssDomain(webhookUrl);

		if (!webhookUrl) {
			return;
		}

		retry = Number(retry);
		if (isNaN(retry) || retry < 0) {
			retry = 0;
		}

		const headers = {
			'Content-Type': 'application/json'
		};

		if (webhookSecret) {
			headers['Authorization'] = webhookSecret;
		}

		// const body = JSON.stringify({
		// 	emailId: emailRow.emailId,
		// 	sendEmail: emailRow.sendEmail,
		// 	sendName: emailRow.name,
		// 	toEmail: emailRow.toEmail,
		// 	toName: emailRow.toName,
		// 	subject: emailRow.subject,
		// 	text: emailRow.text,
		// 	content: emailRow.content,
		// 	code: emailRow.code,
		// 	createTime: emailRow.createTime
		// });
		// 正文合并为一行：text 优先 → content 回退 → 都没有时提示后台查看
		let bodyText = '';
		if (emailRow.text && String(emailRow.text).trim()) {
			bodyText = emailRow.text;
		} else if (emailRow.content && String(emailRow.content).trim()) {
			bodyText = emailRow.content;
		} else {
			bodyText = '请后台查看';
		}

		const contentLines = [
			`NoId: ${emailRow.emailId}`,
			`发件: ${truncate(emailRow.sendEmail, 120)}`,
			`收件: ${truncate(emailRow.toEmail, 120)}`,
			`主题: ${truncate(emailRow.subject, 200)}`,
			`text: ${truncate(bodyText, 1200)}`,
			`时间: ${emailRow.createTime}`
		];
		if (emailRow.code) {
			contentLines.push(`验证码: ${emailRow.code}`);
		}
		const content = contentLines.join("\n");

		const finalContent = truncate(content, MAX_BYTES);
		const body = JSON.stringify({
			msgtype: "text",
			text: {
				content: finalContent
			}
		});
		console.info(`Webhook 载荷: emailId=${emailRow.emailId} 原始=${new TextEncoder().encode(content).length}B 发送=${new TextEncoder().encode(finalContent).length}B`);

		let lastError = '';
		let host = webhookUrl;
		try {
			host = new URL(webhookUrl).host;
		} catch (e) {
			// URL 转换异常时保留原值，仅用于日志
		}

		for (let i = 0; i <= retry; i++) {
			try {
				const res = await fetch(webhookUrl, {
					method: 'POST',
					headers,
					body
				});

				const responseText = await res.text();

				// 企微/钉钉等机器人即使业务失败也返回 HTTP 200，需要解析响应体
				let payload = null;
				try {
					payload = JSON.parse(responseText);
				} catch (e) {
					// 非 JSON 响应按 HTTP 状态码判断
				}

				if (payload && payload.errcode !== undefined && Number(payload.errcode) !== 0) {
					throw new Error(`errcode: ${payload.errcode} errmsg: ${payload.errmsg || ''}`);
				}

				if (payload && payload.StatusCode !== undefined && Number(payload.StatusCode) !== 0) {
					throw new Error(`StatusCode: ${payload.StatusCode} message: ${payload.StatusMessage || ''}`);
				}

				if (!res.ok) {
					throw new Error(`status: ${res.status} response: ${responseText}`);
				}

				console.info(`Webhook 推送成功: ${host} emailId=${emailRow.emailId}`);
				return;
			} catch (e) {
				lastError = e.message;
			}

			if (i < retry) {
				await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
			}
		}

		console.error(`Webhook 推送失败: ${host} emailId=${emailRow.emailId} error=${lastError}`);
	}

};

export default webhookService;
