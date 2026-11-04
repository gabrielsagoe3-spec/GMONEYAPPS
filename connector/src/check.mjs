import {ConnectorApi} from './api.mjs';
try {
  const data=await new ConnectorApi().call('workspace');
  if(!data || !Array.isArray(data.answers) || !Array.isArray(data.jobs))throw Error('Unexpected workspace response');
  console.log('Scoped G Money credential verified.');
} catch {
  console.error('The scoped G Money credential could not be verified. Create a connector credential in the signed-in Applications page and rerun setup.');
  process.exitCode=1;
}
