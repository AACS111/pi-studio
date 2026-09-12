import type { Metadata, Viewport } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import { PwaRegistration } from "@/components/PwaRegistration";
import { LiquidSendFxHost } from "@/components/LiquidSendFx";
import "katex/dist/katex.min.css";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pi Studio",
  description: "Pi Studio interface for the pi coding agent",
  applicationName: "Pi Studio",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pi Studio",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F8FA" },
    { media: "(prefers-color-scheme: dark)", color: "#0D0F12" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");if(t==="dark")document.documentElement.classList.add("dark")}catch(e){}try{(function () {var p = window.piElectron;if (p && p.isElectron) {document.documentElement.classList.add("desktop-glass");}}).call(window)}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate">
        {/* 液态（gooey）融合滤镜：零尺寸 SVG 常驻，供 .pi-liquid 层
            filter:url(#pi-goo) 引用。feGaussianBlur 把各水块模糊后
            feColorMatrix 把 alpha 放大，半透明接缝被推成不透明，
            圆/胶囊自动粘成一体并长出“水滴桥”。

            ★ 融合距离上限 ≈ blur 值（stdDeviation）本身：实测 stdDeviation=8 时
            间隙 12px 还能拉出桥，16px 就只剩两个各胖了一圈的圆。所以**任何两个
            要连成液体的水块，间距必须小于这个值**——分裂用的液柱（见 .pi-vein-dot）
            就是靠这一点把主球和远端按钮串成一条水系，而不是让水滴各自飞。
            提高 blur 会同时扩大融合半径与边缘柔度，所以 contrast 要一起调：
            两者按比例（≈ blur:contrast = 8:22）才能保住清晰的液面。

            ★ 滤镜区域（x/y/width/height）是**硬裁剪**：落在区域外的像素直接不渲染。
            默认 -60%/220% 只覆盖 root 上下各约 80px——液柱稍微往下/往上伸一点就
            被剪断（实测分裂液柱在目标较远时中途消失）。这里纵向放到 400%，
            足够容纳「主球 → 两侧按钮」的液柱，又不会把离屏缓冲撑得太大。 */}
        <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
          <defs>
            <filter id="pi-goo" x="-40%" y="-150%" width="180%" height="400%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="11" result="blur" />
              <feColorMatrix
                in="blur"
                mode="matrix"
                values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11.5"
                result="goo"
              />
              {/* atop（而非 blend）：只保留 SourceGraphic 落在融合剪影内的部分，
                  软边被剪影“咬”出清晰液面；blend 会让源图的抗锯齿软边浮在
                  融合体上，近看是一圈虚边。 */}
              <feComposite in="SourceGraphic" in2="goo" operator="atop" />
            </filter>
          </defs>
        </svg>
        {children}
        {/* 全局单例的液态反馈宿主：不可放进 ChatInput 子树
            （空会话发出首条消息时 ChatWindow 会切分支、ChatInput 直接被卸载） */}
        <LiquidSendFxHost />
        <PwaRegistration />
      </body>
    </html>
  );
}
