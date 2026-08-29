/**
 * components/percho/icons.tsx —— percho chat 组件所需的内联 SVG 图标。
 * 来源：percho packages/desktop/src/renderer/src/components/icons/index.tsx（仅搬运 chat 组件用到子集）。
 */
interface IconProps {
	size?: number;
	className?: string;
}

export function TodoPendingIcon({ size = 14, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
		</svg>
	);
}

export function TodoCompleteIcon({ size = 14, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				className="todo-check-path"
				d="M3.5 8.5l3 3 6-7"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function TodoSpinnerIcon({ size = 14, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle
				cx="8"
				cy="8"
				r="6"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeDasharray="26 12"
				strokeLinecap="round"
			/>
		</svg>
	);
}

export function ExpandArrowIcon({ size = 10, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 1024 1024"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M296.8 856l357.8-344-357.8-344c-7.9-7.5-12.4-18-12.5-28.9 0-36.5 45.9-54.8 72.7-28.9l357.8 344c33.3 32 33.3 83.9 0 115.8L357 913.9c-26.8 25.8-72.7 7.5-72.7-28.9 0-11 4.5-21.4 12.5-29z" />
		</svg>
	);
}

export function ErrorCircleIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="10" />
			<line x1="12" y1="8" x2="12" y2="12" />
			<line x1="12" y1="16" x2="12.01" y2="16" />
		</svg>
	);
}

export function CopyIcon({ size = 12, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="5" y="5" width="9" height="9" rx="1.5" />
			<path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
		</svg>
	);
}

export function RefreshIcon({ size = 13, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.9 4.4 2.2" />
			<path d="M13.5 2.5v2.5H11" />
		</svg>
	);
}

export function GearIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</svg>
	);
}

export function ChevronRightIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}

export function CopyActionIcon({ size = 13, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="5" y="5" width="9" height="9" rx="1.5" />
			<path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
		</svg>
	);
}

export function CopyCheckIcon({ size = 13, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M3 8.5l3.5 3.5L13 4.5" />
		</svg>
	);
}

export function ForkIcon({ size = 13, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="3" cy="3" r="1.6" />
			<circle cx="3" cy="13" r="1.6" />
			<circle cx="13" cy="8" r="1.6" />
			<path d="M3 4.6v6.8M3 8h7" />
		</svg>
	);
}
