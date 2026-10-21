import { Link } from 'react-router'
import { t } from '../i18n'
import { buttonClass } from '../components/ui'

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <p className="font-display text-5xl font-semibold text-line-strong">404</p>
      <h1 className="text-xl font-semibold">{t.app.notFoundTitle}</h1>
      <p className="max-w-md text-sm text-muted">{t.app.notFoundText}</p>
      <Link to="/" className={buttonClass('primary')}>
        {t.app.toHome}
      </Link>
    </div>
  )
}
