export function SuitDivider() {
  return (
    <div className="flex items-center justify-center gap-4 py-4 opacity-30 select-none">
      <span className="text-xl text-ink">♠</span>
      <span className="w-8 h-px bg-ink"></span>
      <span className="text-xl text-red-600">♥</span>
      <span className="w-8 h-px bg-ink"></span>
      <span className="text-xl text-ink">♣</span>
      <span className="w-8 h-px bg-ink"></span>
      <span className="text-xl text-red-600">♦</span>
    </div>
  );
}

function OrnamentSVG({
  symbol,
  className,
}: {
  symbol: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Responsive Scaling: Min 60px, Max 120px, scaling with viewport width
      className={`w-[clamp(60px,10vw,120px)] h-[clamp(60px,10vw,120px)] ${className ?? ""}`}
    >
      {/* 1. The L-shaped Corner Base */}
      <path d="M2 2 L50 2 M2 2 L2 50" strokeWidth="4" />

      {/* 2. The Suit Symbol */}
      <text
        x="35"
        y="50"
        fontSize="48"
        fill="currentColor"
        stroke="none"
        textAnchor="middle"
        style={{
          fontFamily: "var(--font-serif)",
          transformBox: "fill-box",
          transformOrigin: "center",
          transform: "rotate(135deg)",
        }}
      >
        {symbol}
      </text>
    </svg>
  );
}

const baseClass = "absolute opacity-[0.08] text-ink pointer-events-none z-0";

export function TopCornerOrnaments() {
  return (
    <>
      {/* Top Left - Spade */}
      <div className={`${baseClass} top-2 left-2`}>
        <OrnamentSVG symbol="♠" />
      </div>

      {/* Top Right - Diamond - Rotated 90deg */}
      <div className={`${baseClass} top-2 right-2 rotate-90`}>
        <OrnamentSVG symbol="♦" />
      </div>
    </>
  );
}

export function BottomCornerOrnaments() {
  return (
    <>
      {/* Bottom Left - Club - Rotated -90deg */}
      <div className={`${baseClass} bottom-2 left-2 -rotate-90`}>
        <OrnamentSVG symbol="♣" />
      </div>

      {/* Bottom Right - Heart - Rotated 180deg */}
      <div className={`${baseClass} bottom-2 right-2 rotate-180`}>
        <OrnamentSVG symbol="♥" />
      </div>
    </>
  );
}
