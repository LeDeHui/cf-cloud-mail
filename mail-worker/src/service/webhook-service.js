import domainUtils from '../utils/domain-uitls';

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
		const body = JSON.stringify({
			msgtype: "text",
			text: {
				content: [
					`NoId: ${emailRow.emailId}`,
					`发件: ${emailRow.sendEmail}`,
					`收件: ${emailRow.toEmail}`,
					`主题: ${emailRow.subject}`,
					`text: ${emailRow.text}`,
					`内容: ${emailRow.content}`,
					`时间: ${emailRow.createTime}`,
					].join("\n")
			}
			
		});

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
		}

		console.error(`Webhook 推送失败: ${host} emailId=${emailRow.emailId} error=${lastError}`);
	}

};

export default webhookService;
