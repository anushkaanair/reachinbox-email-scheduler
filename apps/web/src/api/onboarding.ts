import { OnboardingStatusSchema, type OnboardingUpdate } from '@ri/shared';
import { api } from './client';

export const fetchOnboarding = () => api('/onboarding', { schema: OnboardingStatusSchema });
export const updateOnboarding = (body: OnboardingUpdate) => api('/onboarding', { method: 'PUT', body, schema: OnboardingStatusSchema });
