// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [signatureEnabled, setSignatureEnabled] = useState(false);
	const [signatureText, setSignatureText] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
	const [autoReplySubject, setAutoReplySubject] = useState("");
	const [autoReplyMessage, setAutoReplyMessage] = useState("");
	const [autoReplyLimit, setAutoReplyLimit] = useState("0");
	const [forwardingEnabled, setForwardingEnabled] = useState(false);
	const [forwardingEmail, setForwardingEmail] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setSignatureEnabled(Boolean(mailbox.settings?.signature?.enabled));
			setSignatureText(mailbox.settings?.signature?.text || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			setAutoReplyEnabled(Boolean(mailbox.settings?.autoReply?.enabled));
			setAutoReplySubject(mailbox.settings?.autoReply?.subject || "");
			setAutoReplyMessage(mailbox.settings?.autoReply?.message || "");
			setAutoReplyLimit(
				String(mailbox.settings?.autoReply?.dailyLimit ?? 0),
			);
			setForwardingEnabled(Boolean(mailbox.settings?.forwarding?.enabled));
			setForwardingEmail(mailbox.settings?.forwarding?.email || "");
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const parsedLimit = Math.max(0, Math.floor(Number(autoReplyLimit) || 0));
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			signature: {
				enabled: signatureEnabled,
				text: signatureText,
			},
			agentSystemPrompt: agentPrompt.trim() || undefined,
			autoReply: {
				enabled: autoReplyEnabled,
				subject: autoReplySubject,
				message: autoReplyMessage,
				dailyLimit: parsedLimit,
			},
			forwarding: {
				enabled: forwardingEnabled,
				email: forwardingEmail.trim(),
			},
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "设置已保存" });
		} catch {
			toastManager.add({
				title: "保存设置失败",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">设置</h1>

			<div className="space-y-6">
				{/* Identity */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						身份
					</div>
					<div className="space-y-3">
						<Input
							label="显示名"
							placeholder="发信时显示的名字"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="邮箱地址" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				{/* Signature */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-3">
						<div className="text-sm font-medium text-kumo-default">签名</div>
						<label className="flex items-center gap-2 text-sm text-kumo-default cursor-pointer">
							<input
								type="checkbox"
								checked={signatureEnabled}
								onChange={(e) => setSignatureEnabled(e.target.checked)}
							/>
							启用签名
						</label>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						未启用或签名为空时，写信会使用首页的默认签名模板。
					</p>
					<textarea
						value={signatureText}
						onChange={(e) => setSignatureText(e.target.value)}
						placeholder="写在邮件末尾的签名"
						rows={5}
						disabled={!signatureEnabled}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring disabled:opacity-60"
					/>
				</div>

				{/* Auto Reply */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-3">
						<div className="text-sm font-medium text-kumo-default">自动回复</div>
						<label className="flex items-center gap-2 text-sm text-kumo-default cursor-pointer">
							<input
								type="checkbox"
								checked={autoReplyEnabled}
								onChange={(e) => setAutoReplyEnabled(e.target.checked)}
							/>
							启用自动回复
						</label>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						收到新邮件时自动发送固定回复（已内置防死循环：不回复自动邮件/退信/邮件列表）。
					</p>
					<div className="space-y-3">
						<Input
							label="回复主题"
							placeholder="例如：已收到您的来信"
							value={autoReplySubject}
							onChange={(e) => setAutoReplySubject(e.target.value)}
							disabled={!autoReplyEnabled}
						/>
						<textarea
							value={autoReplyMessage}
							onChange={(e) => setAutoReplyMessage(e.target.value)}
							placeholder="自动回复的正文内容"
							rows={4}
							disabled={!autoReplyEnabled}
							className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring disabled:opacity-60"
						/>
						<Input
							label="每日上限（0 = 不限制）"
							type="number"
							min={0}
							placeholder="0"
							value={autoReplyLimit}
							onChange={(e) => setAutoReplyLimit(e.target.value)}
							disabled={!autoReplyEnabled}
						/>
						<p className="text-xs text-kumo-subtle">
							每个邮箱每天最多自动回复多少封，超出后当天不再自动回复（按 UTC 日重置）。设为 0 表示不限制。
						</p>
					</div>
				</div>

				{/* Forwarding */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-3">
						<div className="text-sm font-medium text-kumo-default">转发</div>
						<label className="flex items-center gap-2 text-sm text-kumo-default cursor-pointer">
							<input
								type="checkbox"
								checked={forwardingEnabled}
								onChange={(e) => setForwardingEnabled(e.target.checked)}
							/>
							启用转发
						</label>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						收到新邮件时把副本转发到指定邮箱。
					</p>
					<Input
						label="转发目标邮箱"
						type="email"
						placeholder="you@example.com"
						value={forwardingEmail}
						onChange={(e) => setForwardingEmail(e.target.value)}
						disabled={!forwardingEnabled}
					/>
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI 助手提示词
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">自定义</Badge>
							) : (
								<Badge variant="secondary">默认</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								恢复默认
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						自定义这个邮箱里 AI 助手的语气和规则。留空则使用内置默认提示词。
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={8}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						这段文字会作为系统提示发送给模型，用来控制助手的个性和回复风格。
					</p>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						保存
					</Button>
				</div>
			</div>
		</div>
	);
}
