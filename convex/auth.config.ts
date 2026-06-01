declare const process: {
  env: {
    CLERK_FRONTEND_API_URL?: string;
  };
};

const clerkFrontendApiUrl = process.env.CLERK_FRONTEND_API_URL;

export default {
  providers: clerkFrontendApiUrl
    ? [
        {
          domain: clerkFrontendApiUrl,
          applicationID: 'convex',
        },
      ]
    : [],
};
