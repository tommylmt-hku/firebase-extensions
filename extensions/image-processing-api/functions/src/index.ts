/*
 * Copyright (c) 2016-present Invertase Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this library except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AssertionError } from 'assert';
import a2a from 'a2a';
import cors from 'cors';
import express, { Request, Response } from 'express';
import * as firebase from 'firebase-admin';
import { onRequest } from 'firebase-functions/v2/https';
import { info, error, warn, debug } from 'firebase-functions/logger';
import helmet from 'helmet';
import { StructError } from 'superstruct';

import {
  applyValidatedOperation,
  asValidatedOperations,
  jsonAsValidatedOperations,
} from './operations';
import {
  expressAsyncHandlerWrapper,
  fileMetadataBufferKeys,
  omitKeys,
} from './utils';
import { Operation, ValidatedOperation } from './types';
import { extensionConfiguration } from './config';
import sharp from 'sharp';

async function processImageRequest(
  validatedOperations: ValidatedOperation[],
  res: Response,
): Promise<void> {
  const firstOperation = validatedOperations[0];
  const lastOperation = validatedOperations[validatedOperations.length - 1];

  // Ensure input is the first operation.
  if (firstOperation.operation != 'input') {
    throw new AssertionError({
      message: `An input operation must be the first operation.`,
    });
  }

  // Ensure output is the last operation.
  if (lastOperation.operation != 'output') {
    throw new AssertionError({
      message: `An output operation must be the last operation.`,
    });
  }

  // Apply operations.
  let instance: sharp.Sharp | null = null;
  for (let i = 0; i < validatedOperations.length; i++) {
    const validatedOperation = validatedOperations[i];
    instance = await applyValidatedOperation(instance, validatedOperation);
  }

  const finalFileMetadata = omitKeys(
    await (instance as sharp.Sharp).metadata(),
    fileMetadataBufferKeys,
  );

  if (lastOperation.options.debug == true) {
    res.json({
      operations: validatedOperations,
      metadata: finalFileMetadata,
    });
    return;
  }

  const output = await (instance as sharp.Sharp).toBuffer({
    resolveWithObject: true,
  });
  const { data, info } = output;

  debug(`Processed a new request.`, validatedOperations);

  const headers = {
    'Content-Type': `image/${info.format}`,
    'Content-Length': Buffer.byteLength(data),
    'Content-Disposition': `inline; filename=image.${info.format}`,
    'Cache-control': 'public, max-age=31536000', // 1 Year
  };

  // Attach output information as response headers.
  Object.entries(info).forEach(entry => {
    headers[`ext-output-info-${entry[0].toLowerCase()}`] = `${entry[1]}`;
  });

  // Attach sharp metadata as response headers.
  Object.entries(finalFileMetadata).forEach(entry => {
    headers[`ext-metadata-${entry[0].toLowerCase()}`] = `${entry[1]}`;
  });

  res.writeHead(200, headers);
  res.end(data);
}

const app = express();

app.use(helmet());

app.use(
  cors({
    origin: extensionConfiguration.corsAllowList,
    methods: ['GET', 'POST', 'HEAD'],
  }),
);

app.get(
  '/process',
  expressAsyncHandlerWrapper(async (req, res, next) => {
    const operationsString = req.query.operations as string;
    if (!operationsString || !operationsString.length) {
      return next(
        new AssertionError({
          message: `An 'operations' query parameter - a json array of operations to perform - converted to a json string and url encoded.`,
        }),
      );
    }
    let operations: Operation[] = [];
    try {
      operations = JSON.parse(decodeURIComponent(operationsString));
    } catch (e) {
      return next(
        new AssertionError({
          message: `Invalid operations JSON string. ${e.message}`,
        }),
      );
    }

    const validatedOperations: ValidatedOperation[] =
      jsonAsValidatedOperations(operations);
    const [processError] = await a2a(
      processImageRequest(validatedOperations, res),
    );
    if (processError) {
      return next(processError);
    }
  }),
);

app.get(
  '/process/**',
  expressAsyncHandlerWrapper(async (req, res, next) => {
    const operationsString = req.url.replace('/process/', '');
    if (!operationsString || !operationsString.length) {
      return next();
    }
    const validatedOperations: ValidatedOperation[] =
      asValidatedOperations(operationsString);
    const [processError] = await a2a(
      processImageRequest(validatedOperations, res),
    );
    if (processError) {
      return next(processError);
    }
  }),
);

// Express requires the function to have 4 arguments for a handler
// to be treated as an error handler.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(function handleError(err: Error, req: Request, res: Response) {
  if (err instanceof StructError || err instanceof AssertionError) {
    warn(err.message, {
      url: req.url,
      query: req.query,
    });
    res.status(400).send(err.message);
  } else {
    error(
      'An error occurred processing a request, please report this issue to the GitHub ' +
        'repository for this extension and include this log entry with your report (omit any ' +
        'sensitive data).',
      {
        url: req.url,
        query: req.query,
        error: {
          message: err.message,
          stack: err.stack,
        },
      },
    );
    res
      .status(500)
      .send('A server error occurred. See server logs for more information.');
  }
});

app.use('*', function notFoundHandler(_req, res) {
  res.status(404).send('Not Found');
});

if (process.env.EXPRESS_SERVER === 'true') {
  app.listen(3001, 'localhost', () =>
    info(`Local dev server listening on http://localhost:3001`),
  );
} else {
  firebase.initializeApp();

  const fn = onRequest(
    {
      region: 'asia-east2',
      memory: '1GiB',
    },
    app,
  );

  exports.ext = {
    image: {
      processing: {
        api: {
          handler: fn,
        },
      },
    },
  };
  exports['ext-image-processing-api-handler'] = fn;
}
