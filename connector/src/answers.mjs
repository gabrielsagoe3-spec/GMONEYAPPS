import {createHash} from 'node:crypto';

export const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
export const questionKey = (text,jobId) => 'question_'+createHash('sha256').update(String(jobId)+'\0'+normalize(text),'utf8').digest('hex').slice(0,24);
const aliases = new Map(Object.entries({
  full_name:['full name','candidate name'],first_name:['first name','given name'],last_name:['last name','surname','family name'],
  email:['email','email address'],phone:['phone','phone number','telephone','telephone number'],
  postal_code:['zip','zip code','zipcode','postal code','postalcode'],
  available_start_date:['available start date','earliest start date','available from','when can you start'],
  expected_graduation:['expected graduation','expected graduation date'],
  requires_sponsorship:['will you now or in the future require sponsorship for employment visa status','will you now or in the future require visa sponsorship','will you require h1b sponsorship in the future','will you require h 1b sponsorship in the future']
}).flatMap(([key,labels])=>labels.map(label=>[normalize(label),key])));
export function answerFor(question,answers=[],jobId) {
  const label=normalize(question), canonical=aliases.get(label), exactKey=questionKey(question,jobId);
  const exact=answers.find(item=>item && item.key===exactKey && typeof item.answer==='string');
  if(exact)return {key:exact.key,answer:exact.answer};
  const known=canonical && answers.find(item=>item?.key===canonical && typeof item.answer==='string');
  return known ? {key:canonical,answer:known.answer} : null;
}
export function blockedQuestion(question,reason='A confirmed answer is required before submitting.',jobId) {
  return {key:aliases.get(normalize(question)) || questionKey(question,jobId),question:String(question).slice(0,1000),reason};
}
