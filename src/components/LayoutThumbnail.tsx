import type { LayoutId } from '../types';

interface LayoutThumbnailProps {
  layoutId: LayoutId;
  active?: boolean;
}

/**
 * Clean 9:16 miniature wireframe showing where the detected facecam box is fixed.
 * Rose-tinted block = Facecam zone; Slate block = Main gameplay/stream zone.
 */
export function LayoutThumbnail({ layoutId, active = false }: LayoutThumbnailProps) {
  const frameStroke = active ? '#E11D48' : '#333A48';
  const camFill = active ? '#E11D48' : '#9F1239';
  const mainFill = '#1C212C';

  return (
    <svg
      viewBox="0 0 36 64"
      className="w-8 h-14 shrink-0 rounded-[4px]"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="35"
        height="63"
        rx="3"
        fill="#0E1117"
        stroke={frameStroke}
        strokeWidth="1"
      />

      {layoutId === 'split-top-cam' && (
        <>
          <rect x="2" y="2" width="32" height="21" rx="1.5" fill={camFill} fillOpacity="0.85" />
          <rect x="2" y="24.5" width="32" height="37.5" rx="1.5" fill={mainFill} />
        </>
      )}

      {layoutId === 'split-bottom-cam' && (
        <>
          <rect x="2" y="2" width="32" height="37.5" rx="1.5" fill={mainFill} />
          <rect x="2" y="41" width="32" height="21" rx="1.5" fill={camFill} fillOpacity="0.85" />
        </>
      )}

      {layoutId === 'split-50-50' && (
        <>
          <rect x="2" y="2" width="32" height="29" rx="1.5" fill={camFill} fillOpacity="0.85" />
          <rect x="2" y="33" width="32" height="29" rx="1.5" fill={mainFill} />
        </>
      )}

      {layoutId === 'pip-top-left' && (
        <>
          <rect x="2" y="2" width="32" height="60" rx="1.5" fill={mainFill} />
          <rect x="4" y="6" width="12" height="12" rx="1.5" fill={camFill} stroke="#F4F5F7" strokeWidth="0.7" />
        </>
      )}

      {layoutId === 'pip-top-right' && (
        <>
          <rect x="2" y="2" width="32" height="60" rx="1.5" fill={mainFill} />
          <rect x="20" y="6" width="12" height="12" rx="1.5" fill={camFill} stroke="#F4F5F7" strokeWidth="0.7" />
        </>
      )}

      {layoutId === 'pip-bottom-left' && (
        <>
          <rect x="2" y="2" width="32" height="60" rx="1.5" fill={mainFill} />
          <rect x="4" y="44" width="12" height="12" rx="1.5" fill={camFill} stroke="#F4F5F7" strokeWidth="0.7" />
        </>
      )}

      {layoutId === 'pip-bottom-right' && (
        <>
          <rect x="2" y="2" width="32" height="60" rx="1.5" fill={mainFill} />
          <rect x="20" y="44" width="12" height="12" rx="1.5" fill={camFill} stroke="#F4F5F7" strokeWidth="0.7" />
        </>
      )}

      {layoutId === 'blurred-bg-cam-top' && (
        <>
          <rect x="2" y="2" width="32" height="60" rx="1.5" fill="#141822" />
          <rect x="11" y="6" width="14" height="12" rx="1.5" fill={camFill} stroke="#F4F5F7" strokeWidth="0.6" />
          <rect x="2" y="22" width="32" height="20" rx="1" fill={mainFill} stroke="#333A48" strokeWidth="0.6" />
        </>
      )}

      {layoutId === 'blurred-bg-cam-bottom' && (
        <>
          <rect x="2" y="2" width="32" height="60" rx="1.5" fill="#141822" />
          <rect x="2" y="20" width="32" height="20" rx="1" fill={mainFill} stroke="#333A48" strokeWidth="0.6" />
          <rect x="11" y="45" width="14" height="12" rx="1.5" fill={camFill} stroke="#F4F5F7" strokeWidth="0.6" />
        </>
      )}

      {layoutId === 'center-crop-focus' && (
        <>
          <rect x="2" y="2" width="32" height="60" rx="1.5" fill={mainFill} />
          <rect x="10" y="24" width="16" height="16" rx="1" fill="none" stroke="#64748B" strokeDasharray="2 1.5" strokeWidth="0.8" />
        </>
      )}

      {layoutId === 'facecam-only-zoom' && (
        <rect x="2" y="2" width="32" height="60" rx="1.5" fill={camFill} fillOpacity="0.85" />
      )}
    </svg>
  );
}
