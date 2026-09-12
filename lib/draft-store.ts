export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

/**
 * 一次粘贴的超长文本会被存成上传目录里的文件，输入框只留一张卡片。
 * 草稿里保存的是文件元信息（不是正文），切会话/刷新后卡片依旧在。
 */
export interface ChatDraftTextFile {
  /** 上传后的文件名（含扩展名） */
  name: string;
  /** 上传目录里的绝对路径，发送时以 @path 形式带给模型 */
  path: string;
  /** 原文长度（字符），卡片副标题用 */
  chars: number;
  /** 正文开头一小段，用于 tooltip 预览 */
  preview: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  textFiles?: ChatDraftTextFile[];
}

const drafts = new Map<string, ChatDraft>();

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    textFiles: draft.textFiles?.map((file) => ({ ...file })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && (draft.textFiles?.length ?? 0) === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}
