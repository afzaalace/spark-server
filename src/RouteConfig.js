// @flow

import type {
  $Application,
  $Request,
  $Response,
  Middleware,
  NextFunction,
} from 'express';
import type { Container } from 'constitute';
import type { Settings } from './types';

import OAuthServer from 'express-oauth-server';
import nullthrows from 'nullthrows';
import multer from 'multer';
import OAuthModel from './OAuthModel';
import HttpError from './lib/HttpError';

const maybe = (middleware: Middleware, condition: boolean): Middleware =>
  (request: $Request, response: $Response, next: NextFunction) => {
    if (condition) {
      middleware(request, response, next);
    } else {
      next();
    }
  };

const injectUserMiddleware = (): Middleware =>
  (request: $Request, response: $Response, next: NextFunction) => {
    const oauthInfo = response.locals.oauth;
    if (oauthInfo) {
      const token = (oauthInfo: any).token;
      // eslint-disable-next-line no-param-reassign
      (request: any).user = token && token.user;
    }
    next();
  };

// in old codebase there was _keepAlive() function in controllers , which
// prevents of closing server-sent-events stream if there aren't events for
// a long time, but according to the docs sse keep connection alive automatically.
// if there will be related issues in the future, we can return _keepAlive() back.
const serverSentEventsMiddleware = (): Middleware =>
  (request: $Request, response: $Response, next: NextFunction) => {
    request.socket.setNoDelay();
    response.writeHead(
      200,
      {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      },
    );

    next();
  };

export default (
  app: $Application,
  container: Container,
  controllers: Array<string>,
  settings: Settings,
) => {
  const oauth = new OAuthServer({
    ACCESS_TOKEN_LIFETIME: settings.ACCESS_TOKEN_LIFETIME,
    allowBearerTokensInQueryString: true,
    model: new OAuthModel(container.constitute('UserRepository')),
  });

  const filesMiddleware = (allowedUploads: ?Array<{
    maxCount: number,
    name: string,
  }> = []): Middleware => nullthrows(allowedUploads).length
    ? multer().fields(allowedUploads)
    : multer().any();

  app.post(settings.LOGIN_ROUTE, oauth.token());

  controllers.forEach((controllerName: string) => {
    const controller = container.constitute(controllerName);
    Object.getOwnPropertyNames(
      (Object.getPrototypeOf(controller): any),
    ).forEach((functionName: string) => {
      const mappedFunction = (controller: any)[functionName];
      const {
        allowedUploads,
        anonymous,
        httpVerb,
        route,
        serverSentEvents,
      } = mappedFunction;

      if (!httpVerb) {
        return;
      }
      (app: any)[httpVerb](
        route,
        maybe(oauth.authenticate(), !anonymous),
        maybe(serverSentEventsMiddleware(), serverSentEvents),
        injectUserMiddleware(),
        maybe(filesMiddleware(allowedUploads), allowedUploads),
        async (request: $Request, response: $Response): Promise<void> => {
          const argumentNames = (route.match(/:[\w]*/g) || []).map(
            (argumentName: string): string => argumentName.replace(':', ''),
          );
          const values = argumentNames
            .map((argument: string): string => request.params[argument]);

          let controllerInstance = container.constitute(controllerName);

          // In order parallel requests on the controller, the state
          // (request/response/user) must be added to the controller.
          if (controllerInstance === controller) {
            // throw new Error(
            //   '`Transient.with` must be used when binding controllers',
            // );
            controllerInstance = Object.create(controllerInstance);
          }

          controllerInstance.request = request;
          controllerInstance.response = response;
          controllerInstance.user = (request: any).user;

          // Take access token out if it's posted.
          const {
            access_token, // eslint-disable-line no-unused-vars
            ...body
          } = request.body;

          try {
            const functionResult = mappedFunction.call(
              controllerInstance,
              ...values,
              body,
            );

            if (functionResult.then) {
              const result = await Promise.race([
                functionResult,
                !serverSentEvents
                  ? new Promise(
                    (resolve: () => void, reject: () => void): number =>
                      setTimeout(
                        (): void => reject(new Error('timeout')),
                        settings.API_TIMEOUT,
                      ),
                  )
                  : null,
              ]);
              response
                .status(nullthrows(result).status)
                .json(nullthrows(result).data);
            } else {
              response.status(functionResult.status).json(functionResult.data);
            }
          } catch (error) {
            const httpError = new HttpError(error);
            response.status(httpError.status).json({
              error: httpError.message,
              ok: false,
            });
          }
        });
    });
  });

  app.all('*', (request: $Request, response: $Response) => {
    response.sendStatus(404);
  });

  (app: any).use((
    error: Error,
    request: $Request,
    response: $Response,
    // eslint-disable-next-line no-unused-vars
    next: NextFunction,
  ) => {
    response
      .status(400)
      .json({
        error: error.code ? error.code : error,
        ok: false,
      });
  });
};
