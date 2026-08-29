"use client";
/**
 * components/percho/use-shown-working.ts —— working 信号滞后缓冲。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/use-shown-working.ts
 */
import { useEffect, useRef, useState } from "react";

/** working → worked 切换的缓冲时长：turn/工具间隙内不闪烁 */
const HYSTERESIS_MS = 1500;

export function useShownWorking(working: boolean, endImmediately = false, resetKey?: string | null): boolean {
	const [shownWorking, setShownWorking] = useState(working);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevKeyRef = useRef(resetKey);
	useEffect(() => {
		if (prevKeyRef.current !== resetKey) {
			prevKeyRef.current = resetKey;
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setShownWorking(working);
			return;
		}
		if (working) {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setShownWorking(true);
		} else if (shownWorking) {
			if (endImmediately) {
				setShownWorking(false);
				return;
			}
			if (!timerRef.current) {
				timerRef.current = setTimeout(() => {
					timerRef.current = null;
					setShownWorking(false);
				}, HYSTERESIS_MS);
			}
		}
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [working, shownWorking, endImmediately, resetKey]);
	return shownWorking;
}
