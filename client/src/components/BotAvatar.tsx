import { useEffect, useRef } from "react";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { AVATAR_TONES, PIE, type AvatarMood, type AvatarTone } from "@/lib/avatar";

/**
 * The bot's face, live: the same definition the static PNGs come from, drawn by the renderer that
 * owns the volume, blinking and gaze — so the rail shows a character that looks at the pointer and
 * changes mood with the work, instead of a bitmap that would need one animation per state.
 */
export function BotAvatar({
  mood,
  tone = AVATAR_TONES.idle,
  size = 26,
  followPointer = true,
}: {
  mood: AvatarMood;
  /** Body and eye colour: the rail tints it by what is running, so a subagent is not a silent change. */
  tone?: AvatarTone;
  size?: number;
  followPointer?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);

  useEffect(() => {
    if (host.current === null) return;
    const mounted = mountAvatar(host.current, {
      definition: PIE,
      color: tone.color,
      eyeColor: tone.eyeColor,
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

  useEffect(() => {
    avatar.current?.update({ color: tone.color, eyeColor: tone.eyeColor });
  }, [tone]);

  return <div ref={host} style={{ width: size, height: size }} className="shrink-0" aria-hidden />;
}
