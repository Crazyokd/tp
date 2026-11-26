export function installRecordingCursor(): void {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      const host = document.createElement('tp-recording-cursor');
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('popover', 'manual');
      host.style.cssText =
        'position:fixed;inset:auto;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;background:none;overflow:visible;pointer-events:none;opacity:0;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const styles = new CSSStyleSheet();
      styles.replaceSync(':host::backdrop { display: none !important; }');
      shadow.adoptedStyleSheets = [styles];
      const ring = document.createElement('div');
      ring.style.cssText =
        'position:absolute;width:40px;height:40px;border:3px solid #ff7a1a;border-radius:50%;background:#ff7a1a33;box-shadow:0 0 0 2px #fff;transform:translate(-50%,-50%);opacity:0;pointer-events:none;';
      const hand = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      hand.setAttribute('viewBox', '0 0 24 30');
      hand.setAttribute('width', '36');
      hand.setAttribute('height', '45');
      hand.style.cssText =
        'position:absolute;transform:translate(-13.5px,-3px);overflow:visible;pointer-events:none;filter:drop-shadow(0 2px 2px #0006);';
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute(
        'd',
        'M7 15V4a2 2 0 0 1 4 0v7a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v7c0 5-3 8-7 8h-2c-2 0-4-1-5-3l-5-7a2 2 0 0 1 3-2l2 2',
      );
      shape.setAttribute('fill', '#fff');
      shape.setAttribute('stroke', '#172033');
      shape.setAttribute('stroke-width', '1.7');
      shape.setAttribute('stroke-linecap', 'round');
      shape.setAttribute('stroke-linejoin', 'round');
      hand.append(shape);
      shadow.append(ring, hand);
      document.documentElement.append(host);
      host.showPopover();

      document.addEventListener(
        'pointermove',
        (event) => {
          host.style.left = `${event.clientX}px`;
          host.style.top = `${event.clientY}px`;
          host.style.opacity = '1';
          if (event.target instanceof Element && event.target.closest(':modal, :popover-open')) {
            host.hidePopover();
            host.showPopover();
          }
        },
        true,
      );
      document.addEventListener(
        'pointerdown',
        (event) => {
          host.style.left = `${event.clientX}px`;
          host.style.top = `${event.clientY}px`;
          host.style.opacity = '1';
          // Promote the decoration above a dialog opened after this document loaded.
          host.hidePopover();
          host.showPopover();
          for (const animation of ring.getAnimations()) animation.cancel();
          ring.animate(
            [
              { transform: 'translate(-50%,-50%) scale(.5)', opacity: 1 },
              { transform: 'translate(-50%,-50%) scale(1.8)', opacity: 0 },
            ],
            { duration: 550, easing: 'ease-out' },
          );
        },
        true,
      );
      document.addEventListener(
        'toggle',
        (event) => {
          if (event.target !== host && (event as ToggleEvent).newState === 'open') {
            host.hidePopover();
            host.showPopover();
          }
        },
        true,
      );
      document.addEventListener(
        'pointerout',
        (event) => {
          if (event.relatedTarget === null || event.relatedTarget instanceof HTMLIFrameElement)
            host.style.opacity = '0';
        },
        true,
      );
    },
    { once: true },
  );
}
