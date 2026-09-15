declare module 'web-push' {
  interface PushSubscription {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  }

  interface NotificationOptions {
    TTL: number;
    urgency: string;
    timeout: number;
  }

  interface WebPush {
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    sendNotification(subscription: PushSubscription, payload: string, options: NotificationOptions): Promise<void>;
  }

  const webPush: WebPush;
  export default webPush;
}
