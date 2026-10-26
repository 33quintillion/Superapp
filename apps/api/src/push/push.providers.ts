import { createPrivateKey } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ApnsProvider } from './apns.provider';
import { FcmProvider, parseServiceAccount } from './fcm.provider';
import { PushProvider, PushProviderName } from './push.types';
import { VapidSigner } from './webpush';
import { WebPushProvider } from './webpush.provider';

/**
 * The push providers this deployment has credentials for. Each one is optional: devices
 * can register for any provider, but only configured ones get notifications. Bad
 * credentials stop the API at startup rather than failing quietly at send time.
 */
@Injectable()
export class PushProviders implements OnApplicationShutdown {
  private readonly logger = new Logger('Push');
  private readonly byName = new Map<PushProviderName, PushProvider>();
  readonly vapidPublicKey: string | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (config.APNS_PRIVATE_KEY) {
      const pem = config.APNS_PRIVATE_KEY.replace(/\\n/g, '\n');
      assertKey(pem, 'APNS_PRIVATE_KEY', 'ec');
      this.byName.set(
        'apns',
        new ApnsProvider({
          keyId: config.APNS_KEY_ID!,
          teamId: config.APNS_TEAM_ID!,
          bundleId: config.APNS_BUNDLE_ID!,
          privateKey: pem,
          endpoint: config.APNS_ENDPOINT,
        }),
      );
    }
    if (config.FCM_SERVICE_ACCOUNT_JSON) {
      const account = parseServiceAccount(config.FCM_SERVICE_ACCOUNT_JSON);
      assertKey(account.private_key.replace(/\\n/g, '\n'), 'FCM_SERVICE_ACCOUNT_JSON private_key', 'rsa');
      if (config.NODE_ENV !== 'test' && !account.token_uri.startsWith('https://')) {
        throw new Error('FCM_SERVICE_ACCOUNT_JSON token_uri must be https');
      }
      this.byName.set('fcm', new FcmProvider(account, config.FCM_ENDPOINT));
    }
    if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT) {
      const signer = new VapidSigner({ publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY }, config.VAPID_SUBJECT);
      this.byName.set('webpush', new WebPushProvider(signer));
      this.vapidPublicKey = config.VAPID_PUBLIC_KEY;
    } else {
      this.vapidPublicKey = null;
    }
    if (config.NODE_ENV !== 'test') this.logger.log(`push providers configured: ${this.configured().join(', ') || 'none'}`);
  }

  get(name: PushProviderName): PushProvider | undefined {
    return this.byName.get(name);
  }

  configured(): PushProviderName[] {
    return [...this.byName.keys()];
  }

  async onApplicationShutdown() {
    for (const p of this.byName.values()) await p.close?.();
  }
}

function assertKey(pem: string, name: string, type: 'ec' | 'rsa') {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== type) throw new Error(`expected an ${type.toUpperCase()} key`);
  } catch (err) {
    throw new Error(`${name} is not a valid private key: ${(err as Error).message}`);
  }
}
