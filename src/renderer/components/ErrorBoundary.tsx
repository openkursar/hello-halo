/**
 * Error Boundary - Catches React rendering errors
 *
 * Wraps the entire app to catch component errors and display a user-friendly UI.
 * This complements the global error handler in index.html which catches pre-React errors.
 *
 * Also usable around a single pane (pass `fallback`), so a failure that only
 * costs one view does not have to escalate to the full-window diagnostic screen.
 */

import { Component, ReactNode } from 'react'
import { HaloLogo } from './brand/HaloLogo'

interface Props {
  children: ReactNode
  /**
   * Replacement UI for a scoped boundary. Omit it at the app root to get the
   * full diagnostic screen (message, stack, reload).
   */
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log for debugging
    console.error('[ErrorBoundary] Caught error:', error)
    console.error('[ErrorBoundary] Component stack:', info.componentStack)

    this.setState({
      errorInfo: info.componentStack || null
    })
  }

  private handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      const { error, errorInfo } = this.state
      const errorMessage = error?.message || 'Unknown error'
      const errorStack = error?.stack || ''

      return (
        <div className="h-full w-full flex flex-col items-center justify-center bg-background p-8 overflow-auto">
          <div className="max-w-xl w-full">
            {/* Logo */}
            <div className="flex justify-center mb-6 opacity-60">
              <HaloLogo size="md" />
            </div>

            {/* Title */}
            <h1 className="text-xl font-medium text-center mb-2">
              Something went wrong
            </h1>
            <p className="text-muted-foreground text-sm text-center mb-6">
              An error occurred while rendering the application. Please copy the error below and report it.
            </p>

            {/* Error Details */}
            <pre className="bg-secondary/50 border border-border rounded-lg p-4 text-xs font-mono text-destructive overflow-x-auto whitespace-pre-wrap break-all select-text mb-4">
              {errorMessage}
              {errorStack && `\n\n${errorStack}`}
              {errorInfo && `\n\nComponent Stack:${errorInfo}`}
            </pre>

            {/* Actions */}
            <div className="flex justify-center gap-3">
              <button
                onClick={this.handleReload}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Reload Application
              </button>
            </div>

            {/* Help text */}
            <p className="text-muted-foreground/60 text-xs text-center mt-6">
              If the problem persists, please report at{' '}
              <span className="text-primary">github.com/openkursar/hello-halo/issues</span>
            </p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
