/**
 * Color swatch picker for a space's identity color — used by CreateSpaceForm
 * and EditSpaceDialog. Prototype spec (`.swatch span`): 26×26, 8px radius,
 * 2px border that turns solid on the selected swatch, 8px gaps.
 */
import { SPACE_COLOR_CSS, SPACE_COLOR_IDS, type SpaceColorId } from './spaceAvatarUtils'
import { useTranslation } from '../../i18n'

export function SpaceColorSwatch({
  value,
  onChange,
}: {
  value: SpaceColorId
  onChange: (color: SpaceColorId) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex gap-2" role="radiogroup" aria-label={t('Icon Color')}>
      {SPACE_COLOR_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          aria-label={id}
          onClick={() => onChange(id)}
          className={`w-[26px] h-[26px] rounded-sm border-2 transition-colors ease-halo ${
            value === id ? 'border-foreground' : 'border-transparent'
          }`}
          style={{ background: SPACE_COLOR_CSS[id] }}
        />
      ))}
    </div>
  )
}
