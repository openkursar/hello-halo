/**
 * AI Source Provider Interface
 *
 * This interface defines the contract that all AI source providers must implement.
 * Following the Open/Closed Principle - open for extension, closed for modification.
 *
 * Each provider handles:
 * - Authentication (if needed)
 * - Configuration management
 * - Backend request configuration generation
 *
 * Design Notes:
 * - Providers are stateless services
 * - Configuration is stored externally (config service)
 * - Providers generate BackendRequestConfig for the OpenAI compat router
 */
import type { AISourceType, BackendRequestConfig, AISourcesConfig, OAuthStartResult, OAuthCompleteResult, AISourceUserInfo } from '../types';
/**
 * Result type for async operations
 */
export interface ProviderResult<T> {
    success: boolean;
    data?: T;
    error?: string;
}
/**
 * OAuth Provider Interface
 *
 * For sources that require OAuth login flow
 */
export interface OAuthProvider {
    /**
     * Start the OAuth login flow
     * Opens browser to login URL and returns state for tracking
     */
    startLogin(): Promise<ProviderResult<OAuthStartResult>>;
    /**
     * Complete the OAuth login flow
     * Polls for token completion and returns user info
     */
    completeLogin(state: string): Promise<ProviderResult<OAuthCompleteResult>>;
    /** Cancel pending authorization without logging out a stored account. */
    cancelLogin?(): Promise<ProviderResult<void>> | void;
    /**
     * Refresh the access token if expired
     */
    refreshToken(): Promise<ProviderResult<void>>;
    /**
     * Check if the current token is valid
     */
    checkToken(): Promise<ProviderResult<{
        valid: boolean;
        expiresIn?: number;
    }>>;
    /** Called after local removal for account-local upstream revocation only. */
    logout(config?: AISourcesConfig): Promise<ProviderResult<void>>;
}
/**
 * AI Source Provider Interface
 *
 * All AI source providers must implement this interface.
 * Providers are responsible for:
 * - Managing their specific configuration
 * - Generating backend request configuration
 * - Handling authentication if required
 */
export interface AISourceProvider {
    /**
     * Unique identifier for this provider
     */
    readonly type: AISourceType;
    /**
     * Human-readable name for display
     */
    readonly displayName: string;
    /**
     * Check if this provider is configured and ready to use
     */
    isConfigured(config: AISourcesConfig): boolean;
    /**
     * Get backend request configuration for making API calls
     *
     * This is the core method that generates the config needed
     * by the OpenAI compat router to make actual API requests.
     *
     * @param config Current AI sources configuration
     * @returns Backend request config or null if not configured
     */
    getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null;
    /**
     * Get the current model ID for this provider
     */
    getCurrentModel(config: AISourcesConfig): string | null;
    /**
     * Get available models for this provider
     * May fetch from remote API or return static list
     */
    getAvailableModels(config: AISourcesConfig): Promise<string[]>;
    /**
     * Refresh provider-specific configuration from remote API
     * (e.g., fetch available models, update user info)
     *
     * @returns Updated configuration for this provider
     */
    refreshConfig?(config: AISourcesConfig): Promise<ProviderResult<Partial<AISourcesConfig>>>;
}
/**
 * OAuth AI Source Provider Interface
 *
 * Extends AISourceProvider for providers that use OAuth authentication
 */
export interface OAuthAISourceProvider extends AISourceProvider, OAuthProvider {
    /**
     * Get the current logged-in user info
     */
    getUserInfo(config: AISourcesConfig): AISourceUserInfo | null;
    /** Verify a legacy account id from the selected credential. */
    getAccountId?(config: AISourcesConfig): Promise<string | null> | string | null;
}
/**
 * Type guard to check if provider supports OAuth
 */
export declare function isOAuthProvider(provider: AISourceProvider): provider is OAuthAISourceProvider;
/**
 * Provider Registry Entry
 *
 * Used by AISourceManager to maintain provider instances
 */
export interface ProviderRegistryEntry {
    type: AISourceType;
    provider: AISourceProvider;
    priority: number;
}
