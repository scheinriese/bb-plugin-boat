import { useEffect, useRef } from "react";

/**
 * BB 0.48.1 has no public setting to omit its Configuration heading. This
 * opt-in patch touches only that empty heading wrapper around our own slot.
 * Remove when settingsSection offers a host-heading option. Any changed host
 * structure quietly uses the ordinary SDK frame.
 */
export function useSettingsFrameTweak(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const root = ref.current;
    const section = root.closest('[data-resource-detail-section="configuration"]');
    if (!(section instanceof HTMLElement)) return;
    const own = section.querySelector('[data-testid="plugin-detail-boat"]');
    if (!own?.contains(root)) return;
    const wrapper = section.firstElementChild;
    if (!(wrapper instanceof HTMLElement) || wrapper.children.length !== 1) return;
    const heading = wrapper.firstElementChild;
    if (heading?.tagName !== "H2" || heading.textContent?.trim() !== "Configuration") return;
    const hidden = wrapper.hidden;
    wrapper.hidden = true;
    return () => { wrapper.hidden = hidden; };
  }, [enabled]);
  return ref;
}
