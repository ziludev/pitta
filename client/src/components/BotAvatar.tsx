import { useEffect, useRef } from "react";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { AVATAR_COLOR, AVATAR_EYE_COLOR, PIE, type AvatarMood } from "@/lib/avatar";

/**
 * The bot's face, live: the same definition the static PNGs come from, drawn by the renderer that
 * owns the volume, blinking and gaze — so the rail shows a character that looks at the pointer and
 * changes mood with the work, instead of a bitmap that would need one animation per state.
 */
export function BotAvatar({
  mood,
  size = 26,
  followPointer = true,
}: {
  mood: AvatarMood;
  size?: number;
  followPointer?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);

  useEffect(() => {
    if (host.current === null) return;
    const mounted = mountAvatar(host.current, {
      definition: PIE,
      color: AVATAR_COLOR,
      eyeColor: AVATAR_EYE_COLOR,
      depth: 5,
      mood,
      followPointer,
      // Decorative: the rail already names the bot next to it.
      label: "",
    });
    avatar.current = mounted;
    return () => {
      mounted.destroy();
      avatar.current = null;
    };
  }, [followPointer]);

  useEffect(() => {
    avatar.current?.update({ mood });
  }, [mood]);

  return <div ref={host} style={{ width: size, height: size }} className="shrink-0" aria-hidden />;
}
