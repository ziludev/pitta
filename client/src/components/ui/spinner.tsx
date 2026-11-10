import { cn } from "cn";
import { spinner } from "@/lib/motion";

/**
 * Motion Prompt #070: a pale ring with a blue 243° arc turning 1.3 times a second.
 * Kept as SVG so it scales and inherits the accent colour.
 */
export function Spinner({ className, size = 16 }: { className?: string; size?: number }) {
  const stroke = size >= 24 ? spinner.thickness : Math.max(2, size / 8);
  const radius = size / 2 - stroke / 2;
  const circumference = 2 * Math.PI * radius;
  const arc = (spinner.arcDegrees / 360) * circumference;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0", className)}
      role="status"
      aria-label="loading"
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={stroke} className="opacity-25" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${arc} ${circumference}`}
        style={{ animation: `mp-spin ${spinner.revSeconds}s linear infinite`, transformOrigin: "50% 50%" }}
      />
    </svg>
  );
}
