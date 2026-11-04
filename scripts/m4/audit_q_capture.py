#!/usr/bin/env python3
"""Read-only M4 fixed-experiment audit. Run ONLY after full 200 games and process exit."""
import argparse
import collections
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import random
import re
import subprocess
import sys

FIXED_Q_PROFILE = {
    'schema_version': 'm4-q-capture-preregistration-v1',
    'experiment': 'q-capture-order', 'requested_games': 200,
    'nodes_per_move': 10000, 'max_ply': 4096, 'master_seed': 1,
    'workers': 4, 'strategy_a': 'search', 'strategy_b': 'search',
    'candidate_side': 'A', 'baseline_side': 'B',
}
RUN_PATH_KEYS = (
    'output_dir', 'manifest_path', 'games_path', 'summary_path',
    'launcher_dir', 'command_path', 'launch_metadata_path', 'stdout_path',
    'stderr_path', 'exit_status_path', 'audit_result_path',
)
KNOWN_RUN_ARTIFACTS = (
    'manifest_path', 'games_path', 'summary_path', 'command_path',
    'launch_metadata_path', 'stdout_path', 'stderr_path', 'exit_status_path', 'audit_result_path',
)
CURRENT_RUN_ARTIFACTS = tuple(key for key in KNOWN_RUN_ARTIFACTS if key!='audit_result_path')

def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def _config_digest(config):
    payload={key:value for key,value in config.items() if key!='preregistration_sha256'}
    encoded=json.dumps(payload,sort_keys=True,separators=(',',':')).encode()
    return hashlib.sha256(encoded).hexdigest()

def _assert_file_ref(label,ref,hash_field='sha256'):
    if not isinstance(ref,dict) or not isinstance(ref.get('path'),str) or not isinstance(ref.get(hash_field),str):
        raise ValueError(f'{label}: path and {hash_field} are required')
    path=Path(ref['path'])
    if not path.is_file():
        raise ValueError(f'{label}: referenced file is missing: {path}')
    actual=file_sha256(path)
    if actual!=ref[hash_field]:
        raise ValueError(f'{label}: SHA-256 mismatch (expected {ref[hash_field]}, actual {actual})')
    return path

def _validate_checkout(label,ref):
    if not isinstance(ref,dict):
        raise ValueError(f'{label}: source reference is required')
    checkout=Path(ref.get('checkout_path',''))
    source=Path(ref.get('source_path',''))
    if not checkout.is_dir() or not source.is_file():
        raise ValueError(f'{label}: checkout/source path is missing')
    try:
        relative=source.resolve().relative_to(checkout.resolve())
    except ValueError as error:
        raise ValueError(f'{label}: source is outside configured checkout') from error
    result=subprocess.run(['git','-C',str(checkout),'rev-parse','HEAD'],capture_output=True,text=True)
    if result.returncode or result.stdout.strip()!=ref.get('checkout_head'):
        raise ValueError(f'{label}: checkout HEAD mismatch')
    actual=file_sha256(source)
    if actual!=ref.get('source_sha256'):
        raise ValueError(f'{label}: SHA-256 mismatch (expected {ref.get("source_sha256")}, actual {actual})')
    return source,relative.as_posix()

def _validate_run_paths(run):
    if not isinstance(run,dict) or any(not isinstance(run.get(key),str) for key in RUN_PATH_KEYS):
        raise ValueError('run must provide every exact output and launcher path')
    raw=run.get('raw_log_paths')
    expected_raw={
        f'workers/worker-{worker:02d}/engine-{side}.log'
        for worker in range(1,5) for side in ('a','b')
    }
    if not isinstance(raw,dict) or set(raw)!=expected_raw or any(not isinstance(path,str) for path in raw.values()):
        raise ValueError('run must provide exactly eight configured raw_log_paths')
    file_paths=[run[key] for key in RUN_PATH_KEYS if key not in ('output_dir','launcher_dir')]
    all_paths=file_paths+list(raw.values())
    if len(set(all_paths))!=len(all_paths):
        raise ValueError('configured raw log paths must be unique')
    return run

def _validate_prior(prior):
    if not isinstance(prior,dict):
        raise ValueError('look 2 requires prior_look')
    prereg_path=Path(prior.get('preregistration_path',''))
    if not prereg_path.is_file() or file_sha256(prereg_path)!=prior.get('preregistration_sha256'):
        raise ValueError('prior look preregistration SHA-256 mismatch')
    previous=json.loads(prereg_path.read_text(encoding='utf-8'))
    if previous.get('look')!=1 or previous.get('experiment')!='q-capture-order':
        raise ValueError('prior look must be the frozen q-capture-order look 1')
    if previous.get('preregistration_sha256')!=_config_digest(previous):
        raise ValueError('prior look preregistration content digest mismatch')
    previous_run=_validate_run_paths(prior.get('run'))
    if previous_run!=previous.get('run'):
        raise ValueError('prior look paths differ from its preregistration')
    artifact_hashes=prior.get('artifact_sha256')
    if not isinstance(artifact_hashes,dict) or set(artifact_hashes)!=set(KNOWN_RUN_ARTIFACTS):
        raise ValueError('prior look must lock hashes for all completed run artifacts')
    for key in KNOWN_RUN_ARTIFACTS:
        path=Path(previous_run[key])
        if not path.is_file() or file_sha256(path)!=artifact_hashes[key]:
            raise ValueError(f'prior look artifact SHA-256 mismatch: {key}')
    return prior

def validate_preregistration(config):
    if not isinstance(config,dict):
        raise ValueError('preregistration must be a JSON object')
    if config.get('preregistration_sha256')!=_config_digest(config):
        raise ValueError('preregistration SHA-256 mismatch')
    if not isinstance(config.get('preregistration_path'),str) or not Path(config['preregistration_path']).is_absolute():
        raise ValueError('preregistration_path must be an absolute path')
    for key,value in FIXED_Q_PROFILE.items():
        if config.get(key)!=value:
            raise ValueError(f'fixed q-capture-order profile mismatch: {key}')
    look=config.get('look')
    rounds=[1,2] if look==1 else [3,4] if look==2 else None
    if rounds is None or config.get('global_rounds')!=rounds:
        raise ValueError('fixed q-capture-order profile mismatch: look/global_rounds')
    if config.get('engine_a_options')!={'QCaptureOrder':'true'} or config.get('engine_b_options')!={'QCaptureOrder':'false'}:
        raise ValueError('fixed q-capture-order profile mismatch: engine flags')
    if config.get('runner_argv') is None:
        raise ValueError('runner_argv is required')
    argv=config['runner_argv']
    if not isinstance(argv,list) or not all(isinstance(arg,str) for arg in argv):
        raise ValueError('runner_argv must be a string array')
    runner,runner_relative=_validate_checkout('runner',config.get('runner'))
    engine,engine_relative=_validate_checkout('engine_source',config.get('engine_source'))
    auditor,auditor_relative=_validate_checkout('auditor',config.get('auditor'))
    binary=_assert_file_ref('binary',config.get('binary'))
    inputs=config.get('inputs')
    expected_inputs={'openings_tsv','selection_protocol','eligible_population','selected_population','replay_executable'}
    if not isinstance(inputs,dict) or set(inputs)!=expected_inputs:
        raise ValueError('inputs must lock the frozen openings, selection, populations, and replay executable')
    input_paths={name:_assert_file_ref(name,ref) for name,ref in inputs.items()}
    run=_validate_run_paths(config.get('run'))
    expected_argv=[
        'python3',str(runner),'--engine-a',str(binary),'--engine-b',str(binary),
        '--experiment','q-capture-order','--engine-a-options','{"QCaptureOrder":"true"}',
        '--engine-b-options','{"QCaptureOrder":"false"}','--strategy-a','search',
        '--strategy-b','search','--openings',str(input_paths['openings_tsv']),
        '--selection-protocol',str(input_paths['selection_protocol']),'--nodes','10000',
        '--games','200','--global-round-start',str(rounds[0]),'--global-round-count','2',
        '--max-ply','4096','--seed','1','--look',str(look),'--workers','4',
        '--output',run['output_dir'],
    ]
    if argv!=expected_argv:
        raise ValueError('runner_argv differs from the exact fixed q-capture-order invocation')
    if look==1:
        if config.get('prior_look') is not None:
            raise ValueError('look 1 must not reference a prior look')
    else:
        _validate_prior(config.get('prior_look'))
        prior_config=json.loads(Path(config['prior_look']['preregistration_path']).read_text(encoding='utf-8'))
        for key in ('binary','runner','engine_source','inputs','experiment','engine_a_options','engine_b_options'):
            if prior_config.get(key)!=config.get(key):
                raise ValueError(f'look 2 prior differs in locked provenance/config: {key}')
    return config

def read_run_evidence(config):
    validate_preregistration(config)
    run=_validate_run_paths(config['run'])
    evidence={'paths':{},'raw_files':[]}
    for key in CURRENT_RUN_ARTIFACTS:
        path=Path(run[key])
        if not path.is_file():
            raise ValueError(f'configured {key} path is missing: {path}')
        evidence[key]=str(path)
        evidence[key.replace('_path','_sha256')]=file_sha256(path)
    exit_data=json.loads(Path(run['exit_status_path']).read_text(encoding='utf-8'))
    if exit_data.get('exit_code')!=0:
        raise ValueError(f'launcher did not record exit0: {exit_data}')
    evidence['exit_status']=exit_data
    prereg_path=Path(config['preregistration_path'])
    if not prereg_path.is_file():
        raise ValueError(f'configured preregistration path is missing: {prereg_path}')
    if json.loads(prereg_path.read_text(encoding='utf-8'))!=config:
        raise ValueError('launcher preregistration content differs from loaded configuration')
    prereg_sha=file_sha256(prereg_path)
    command_path=Path(run['command_path'])
    launch_path=Path(run['launch_metadata_path'])
    try:
        command_data=json.loads(command_path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError,UnicodeDecodeError) as error:
        raise ValueError(f'launcher command evidence: invalid JSON: {error}') from error
    expected_command={
        'schema_version':'m4-q-capture-command-v1',
        'cwd':str(Path(config['runner']['checkout_path']).resolve()),
        'command':config['runner_argv'],
        'engine_sha256':config['binary']['sha256'],
        'output':run['output_dir'],
    }
    if not isinstance(command_data,dict) or command_data!=expected_command:
        raise ValueError('launcher command evidence differs from the exact preregistered argv/cwd/binary/output')
    try:
        launch_data=json.loads(launch_path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError,UnicodeDecodeError) as error:
        raise ValueError(f'launcher launch evidence: invalid JSON: {error}') from error
    expected_launch_keys={
        'schema_version','pid','pgid','sid','started_unix','cwd','runner_head',
        'runner_source_path','runner_source_sha256','command','preregistration',
        'preregistration_sha256','log','stderr','exit_status','output','engine_sha256','runner_pid',
    }
    if not isinstance(launch_data,dict) or set(launch_data)!=expected_launch_keys:
        raise ValueError('launcher launch evidence has an invalid m4-q-capture-launch-v1 field set')
    runner=config['runner']
    _validate_checkout('runner launch',runner)
    expected_launch={
        'schema_version':'m4-q-capture-launch-v1',
        'cwd':str(Path(runner['checkout_path']).resolve()),
        'runner_head':runner['checkout_head'],
        'runner_source_path':str(Path(runner['source_path']).resolve()),
        'runner_source_sha256':runner['source_sha256'],
        'command':str(command_path),
        'preregistration':str(prereg_path),
        'preregistration_sha256':prereg_sha,
        'log':run['stdout_path'],'stderr':run['stderr_path'],
        'exit_status':run['exit_status_path'],'output':run['output_dir'],
        'engine_sha256':config['binary']['sha256'],
    }
    for field,value in expected_launch.items():
        if launch_data.get(field)!=value:
            raise ValueError(f'launcher launch evidence mismatch: {field}')
    for field in ('pid','pgid','sid','runner_pid'):
        value=launch_data.get(field)
        if not isinstance(value,int) or isinstance(value,bool) or value<=0:
            raise ValueError(f'launcher launch evidence invalid {field}')
    started=launch_data.get('started_unix')
    if not isinstance(started,(int,float)) or isinstance(started,bool) or started<=0:
        raise ValueError('launcher launch evidence invalid started_unix')
    evidence['command']=command_data
    evidence['launch']=launch_data
    evidence['preregistration_sha256']=prereg_sha
    for relative,path_value in sorted(run['raw_log_paths'].items()):
        path=Path(path_value)
        if not path.is_file():
            raise ValueError(f'configured raw log path is missing: {path}')
        evidence['raw_files'].append({'path':str(path),'label':relative,'sha256':file_sha256(path)})
    if not Path(run['audit_result_path']).parent.is_dir():
        raise ValueError('configured audit result parent directory is missing')
    return evidence

TSV = None
REPLAY = None
TSV_SHA = None
PROTOCOL_SHA = None
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
errors = []
def require(value, reason):
    if not value:
        errors.append(reason)
def config_hash(manifest):
    data = {k:v for k,v in manifest.items() if k != 'config_sha256'}
    return hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def seed(master, gid, index):
    data=f'xiangqi-m4-match-v1\0{master}\0{gid}\0{index}'.encode()
    return int.from_bytes(hashlib.sha256(data).digest()[:8], 'big')

def profile_manifest_mismatches(manifest,profile,rounds,tsv_sha256=None,selection_protocol_sha256=None):
    future_selection = profile.get('future_selection_manifest_sha256')
    if future_selection is not None:
        selection_protocol_sha256 = None
    mismatches=[]
    expected={
        'requested_games':200,
        'global_round_start':rounds[0],
        'global_round_count':len(rounds),
        'global_rounds':list(rounds),
        'nodes_per_move':10000,
        'max_ply':4096,
        'master_seed':1,
        'strategy_a':'search',
        'strategy_b':'search',
        'candidate_side':'A',
        'baseline_side':'B',
        'engine_a_options':profile['options'][0],
        'engine_b_options':profile['options'][1],
        'experiment':profile['experiment'],
        'look':1 if rounds==(1,2) else 2,
        'openings_sha256':tsv_sha256 if tsv_sha256 is not None else TSV_SHA,
        'selection_protocol_sha256':(
            None if future_selection is not None else
            selection_protocol_sha256 if selection_protocol_sha256 is not None else PROTOCOL_SHA
        ),
    }
    if future_selection is not None:
        expected['future_selection_manifest_sha256'] = future_selection
    for field,value in expected.items():
        if manifest.get(field)!=value:
            mismatches.append(field)
    selection=manifest.get('selection') or {}
    expected_selection = {
        'full_selected_sample':True,
        'frozen_protocol_verified':True,
        'population_size':profile.get('population_size',203),
        'selected_count':profile.get('selected_count',50),
    }
    if future_selection is not None:
        expected_selection['future_openings_verified'] = True
        expected_selection['ordered_sample_count'] = 100
    for field,value in expected_selection.items():
        if selection.get(field)!=value:
            mismatches.append('selection.'+field)
    for field in ('workers','runner_source_sha256'):
        if field in profile and manifest.get(field)!=profile[field]:
            mismatches.append(field)
    for side in 'ab':
        meta=manifest.get(f'engine_{side}_executable') or {}
        if meta.get('sha256')!=profile['binary']:
            mismatches.append(f'engine_{side}_executable.sha256')
    return mismatches

def calculate_cluster_statistics(bykey, rounds):
    opening_ids=sorted({key[0] for key in bykey})
    if len(opening_ids)!=50:
        raise ValueError(f'expected 50 opening clusters, got {len(opening_ids)}')
    cluster={}
    for oid in opening_ids:
        values=[]
        for color in (True,False):
            for round_number in rounds:
                record=bykey.get((oid,color,round_number))
                if record is None:
                    raise ValueError(f'missing cluster result {oid}/{color}/{round_number}')
                result=record[2]
                if result not in ('win','draw','loss'):
                    raise ValueError(f'invalid WDL result {result!r}')
                values.append({'win':1.0,'draw':0.5,'loss':0.0}[result])
        cluster[oid]=sum(values)/len(values)
    mean=sum(cluster.values())/50
    rho=1-49/203
    def interval(alpha,finite):
        radius=math.sqrt((rho if finite else 1)*math.log(2/alpha)/(2*50))
        return [max(0,mean-radius),min(1,mean+radius)]
    return {
        'cluster_count':len(cluster),
        'cluster_scores':cluster,
        'score_mean':mean,
        'report_95_hoeffding_score_interval':interval(.05,False),
        'decision_97_5_score_interval':interval(.025,True),
    }

def batch_summary_mismatches(batch, rounds):
    stats=calculate_cluster_statistics(batch['bykey'],rounds)
    summary=batch['summary'];mismatches=[]
    for field in ('score_mean','report_95_hoeffding_score_interval','decision_97_5_score_interval'):
        expected=stats[field];actual=summary.get(field)
        if isinstance(expected,list):
            if not isinstance(actual,list) or len(actual)!=len(expected) or any(abs(a-b)>1e-12 for a,b in zip(actual,expected)):
                mismatches.append(field)
        elif not isinstance(actual,(int,float)) or abs(actual-expected)>1e-12:
            mismatches.append(field)
    return mismatches

def decision_verdict(score_interval, is_second_look):
    if score_interval is None:
        return 'invalid'
    if score_interval[0]>.5:
        return 'keep'
    if score_interval[1]<.5:
        return 'revert_negative'
    return 'revert_after_second_look' if is_second_look else 'second_look'
def read_jsonl(path):
    return [json.loads(s) for s in path.read_text().splitlines() if s]
def parse_raw(path):
    records=[]; position=None; decision_seed=None; waiting=False
    for line in path.read_text().splitlines():
        if line.startswith('stdin: setoption name RandomSeed value '):
            decision_seed=int(line.rsplit(' ',1)[1])
        elif line.startswith('stdin: position startpos moves '):
            position=line.removeprefix('stdin: position startpos moves ').split()
        elif line == 'stdin: go nodes 10000':
            require(position is not None and decision_seed is not None and not waiting, f'{path.name}: malformed go')
            waiting=True
        elif line.startswith('stdout: bestmove '):
            require(waiting, f'{path.name}: unsolicited bestmove')
            records.append((position,line.removeprefix('stdout: bestmove ').split()[0],decision_seed))
            waiting=False;position=None;decision_seed=None
    require(not waiting, f'{path.name}: unfinished raw go')
    return records

def _raw_paths(run_path, workers):
    if workers < 1:
        raise ValueError(f'invalid worker count: {workers}')
    if workers == 1:
        expected = {'engine-a.log', 'engine-b.log'}
    else:
        expected = {
            f'workers/worker-{worker:02d}/engine-{side}.log'
            for worker in range(1, workers + 1) for side in 'ab'
        }
    observed = {
        path.relative_to(run_path).as_posix()
        for path in run_path.rglob('*.log') if path.is_file()
    }
    workers_dir = run_path/'workers'
    if workers_dir.exists():
        observed.update(
            path.relative_to(run_path).as_posix()
            for path in workers_dir.rglob('*') if path.is_file()
        )
    missing = sorted(expected-observed)
    unknown = sorted(observed-expected)
    if missing or unknown:
        raise ValueError(f'raw file layout mismatch: missing={missing}, unknown={unknown}')
    return {relative: run_path/relative for relative in sorted(expected)}

def _expected_raw_decisions(games, opening_order):
    opening_rank={opening:index for index,opening in enumerate(opening_order)}
    expected={}
    ordered_games=sorted(
        games,
        key=lambda game:(game['global_round'], opening_rank.get(game['opening_id'],len(opening_rank)),
                         0 if game['a_is_red'] else 1),
    )
    for game in ordered_games:
        game_id=game['game_id'];prefix=game['prefix'];moves=game['moves']
        if moves[:len(prefix)]!=prefix:
            raise ValueError(f'{game_id}: raw trace cannot be checked because the opening prefix differs')
        extra=moves[len(prefix):]
        seeds=game.get('decision_seeds')
        if not isinstance(seeds,list) or len(seeds)!=len(extra)+1:
            raise ValueError(f'{game_id}: decision seed count does not match recorded moves')
        for index,decision_seed in enumerate(seeds):
            before=prefix+extra[:index]
            mover_red=len(before)%2==0
            actor='A' if mover_red==game['a_is_red'] else 'B'
            bestmove=extra[index] if index<len(extra) else '0000'
            key=(game_id,actor,index)
            if key in expected:
                raise ValueError(f'duplicate expected decision: {key}')
            expected[key]={
                'position':before,'seed':decision_seed,'nodes':game['nodes'],
                'bestmove':bestmove,
                'outcome':game.get('terminal_outcome') if bestmove=='0000' else None,
            }
    return expected, ordered_games

def _parse_context_log(path, expected_actor):
    marker=re.compile(r'^context: game_id=(\S+) actor=([AB]) decision_index=(\d+)$')
    decisions={};current=None
    def finish(line_number,bestmove):
        nonlocal current
        if current is None:
            raise ValueError(f'{path}:{line_number}: bestmove without game context')
        if any(current.get(field) is None for field in ('position','seed','nodes')):
            raise ValueError(f'{path}:{line_number}: incomplete context decision {current["key"]}')
        current['bestmove']=bestmove
        key=current.pop('key')
        if key[1]!=expected_actor:
            raise ValueError(f'{path}:{line_number}: actor {key[1]} is in engine-{expected_actor.lower()} log')
        if key in decisions:
            raise ValueError(f'{path}:{line_number}: duplicate decision key {key}')
        decisions[key]=current
        current=None
    for line_number,line in enumerate(path.read_text(encoding='utf-8').splitlines(),1):
        if line.startswith('context:'):
            if current is not None:
                raise ValueError(f'{path}:{line_number}: new context before previous bestmove')
            match=marker.fullmatch(line)
            if not match:
                raise ValueError(f'{path}:{line_number}: malformed context marker')
            game_id,actor,index=match.groups()
            current={'key':(game_id,actor,int(index)),'position':None,'seed':None,'nodes':None,'outcome':None}
        elif line.startswith('stdin: setoption name RandomSeed value '):
            if current is None or current.get('seed') is not None:
                raise ValueError(f'{path}:{line_number}: seed outside/duplicated within context')
            try: current['seed']=int(line.rsplit(' ',1)[1])
            except ValueError as error: raise ValueError(f'{path}:{line_number}: malformed RandomSeed') from error
        elif line.startswith('stdin: position startpos moves '):
            if current is None or current.get('position') is not None:
                raise ValueError(f'{path}:{line_number}: position outside/duplicated within context')
            current['position']=line.removeprefix('stdin: position startpos moves ').split()
        elif line.startswith('stdin: go '):
            if current is None or current.get('nodes') is not None:
                raise ValueError(f'{path}:{line_number}: go outside/duplicated within context')
            match=re.fullmatch(r'stdin: go nodes (\d+)',line)
            if not match: raise ValueError(f'{path}:{line_number}: malformed go command')
            current['nodes']=int(match.group(1))
        elif line.startswith('stdout: info string outcome '):
            if current is None or current.get('outcome') is not None:
                raise ValueError(f'{path}:{line_number}: outcome outside/duplicated within context')
            current['outcome']=line.removeprefix('stdout: info string outcome ')
        elif line.startswith('stdout: bestmove '):
            fields=line.split()
            if len(fields)<3: raise ValueError(f'{path}:{line_number}: malformed bestmove')
            finish(line_number,fields[2])
        elif line.startswith('stdin: go nodes ') or line.startswith('stdout: bestmove '):
            raise ValueError(f'{path}:{line_number}: malformed unparsed decision line')
    if current is not None:
        raise ValueError(f'{path}: unfinished context decision {current["key"]}')
    return decisions

def _parse_legacy_log(path,expected_nodes):
    records=[];position=None;decision_seed=None;nodes=None;outcome=None;waiting=False
    for line_number,line in enumerate(path.read_text(encoding='utf-8').splitlines(),1):
        if line.startswith('context:'):
            raise ValueError(f'{path}:{line_number}: mixed legacy and context trace')
        if line.startswith('stdin: setoption name RandomSeed value '):
            if decision_seed is not None: raise ValueError(f'{path}:{line_number}: duplicate RandomSeed')
            try: decision_seed=int(line.rsplit(' ',1)[1])
            except ValueError as error: raise ValueError(f'{path}:{line_number}: malformed RandomSeed') from error
        elif line.startswith('stdin: position startpos moves '):
            if position is not None: raise ValueError(f'{path}:{line_number}: duplicate position')
            position=line.removeprefix('stdin: position startpos moves ').split()
        elif line.startswith('stdin: go '):
            if waiting or position is None or decision_seed is None:
                raise ValueError(f'{path}:{line_number}: malformed legacy go')
            match=re.fullmatch(r'stdin: go nodes (\d+)',line)
            if not match: raise ValueError(f'{path}:{line_number}: malformed legacy go')
            nodes=int(match.group(1));waiting=True
        elif line.startswith('stdout: info string outcome '):
            if not waiting or outcome is not None: raise ValueError(f'{path}:{line_number}: unexpected terminal outcome')
            outcome=line.removeprefix('stdout: info string outcome ')
        elif line.startswith('stdout: bestmove '):
            fields=line.split()
            if not waiting or len(fields)<3: raise ValueError(f'{path}:{line_number}: unexpected bestmove')
            records.append({'position':position,'seed':decision_seed,'nodes':nodes,
                            'bestmove':fields[2],'outcome':outcome})
            position=decision_seed=nodes=outcome=None;waiting=False
    if waiting or position is not None or decision_seed is not None:
        raise ValueError(f'{path}: unfinished legacy decision')
    if any(record['nodes']!=expected_nodes for record in records):
        raise ValueError(f'{path}: legacy raw node budget mismatch')
    return records

def audit_raw_traces(run_path,games,opening_order,manifest_path=None,configured_raw_paths=None):
    manifest_path=Path(manifest_path) if manifest_path else run_path/'run-manifest.json'
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    workers=manifest.get('workers',1)
    if not isinstance(workers,int) or isinstance(workers,bool):
        raise ValueError(f'invalid manifest worker count: {workers!r}')
    if configured_raw_paths is None:
        raw_paths=_raw_paths(run_path,workers)
    else:
        if workers!=4 or len(configured_raw_paths)!=8:
            raise ValueError('configured Q raw log layout requires four workers and eight exact paths')
        raw_paths={label:Path(path) for label,path in sorted(configured_raw_paths.items())}
        if any(not path.is_file() for path in raw_paths.values()):
            raise ValueError('one or more configured raw log paths are missing')
    expected,ordered_games=_expected_raw_decisions(games,opening_order)
    files=[{'path':relative,'sha256':sha(path)} for relative,path in raw_paths.items()]
    has_context=any(
        line.startswith('context:')
        for path in raw_paths.values()
        for line in path.read_text(encoding='utf-8').splitlines()
    )
    if has_context:
        actual={}
        for relative,path in raw_paths.items():
            actor='A' if 'engine-a.log' in relative else 'B'
            parsed=_parse_context_log(path,actor)
            duplicates=set(actual).intersection(parsed)
            if duplicates:
                raise ValueError(f'duplicate raw decision keys across files: {sorted(duplicates)[:4]}')
            actual.update(parsed)
        missing=sorted(set(expected)-set(actual));extra=sorted(set(actual)-set(expected))
        if missing or extra:
            raise ValueError(f'raw decision coverage mismatch: missing={missing[:4]}, extra={extra[:4]}')
        mismatches=[]
        for key,wanted in expected.items():
            got=actual[key]
            if any(got.get(field)!=value for field,value in wanted.items()):
                mismatches.append(key)
        if mismatches: raise ValueError(f'raw decision content mismatch: {mismatches[:4]}')
        by_actor={actor:sum(1 for key in actual if key[1]==actor) for actor in 'AB'}
    else:
        if workers!=1:
            raise ValueError('parallel raw logs require game context markers')
        ordered_keys=[]
        for game in ordered_games:
            for index in range(len(game['decision_seeds'])):
                for actor in 'AB':
                    key=(game['game_id'],actor,index)
                    if key in expected: ordered_keys.append(key)
        by_actor={'A':[],'B':[]}
        for key in ordered_keys: by_actor[key[1]].append(expected[key])
        for actor in 'AB':
            path=raw_paths[f'engine-{actor.lower()}.log']
            records=_parse_legacy_log(path,manifest.get('nodes_per_move',10000))
            wanted=by_actor[actor]
            actual_values=[{field:record[field] for field in ('position','seed','nodes','bestmove','outcome')}
                           for record in records]
            if actual_values!=wanted:
                raise ValueError(f'{path}: legacy raw decisions differ (expected {len(wanted)}, actual {len(records)})')
        by_actor={actor:len(rows) for actor,rows in by_actor.items()}
    return {'worker_count':workers,'decision_count':len(expected),'decisions_by_actor':by_actor,
            'raw_files':files,'context_markers':has_context}

def audit_batch(path, profile, rounds, allow_legacy=False, configured_run=None):
    configured_run=configured_run or {
        'manifest_path':str(path/'run-manifest.json'),
        'games_path':str(path/'games.jsonl'),
        'summary_path':str(path/'summary.json'),
    }
    mpath=Path(configured_run['manifest_path']);gpath=Path(configured_run['games_path']);spath=Path(configured_run['summary_path'])
    manifest=json.loads(mpath.read_text());games=read_jsonl(gpath)
    require(len(games)==200, f'{path}: game count {len(games)}')
    input_refs=profile.get('inputs') or {}
    mismatches=profile_manifest_mismatches(
        manifest,profile,rounds,
        tsv_sha256=input_refs.get('openings_tsv',{}).get('sha256'),
        selection_protocol_sha256=input_refs.get('selection_protocol',{}).get('sha256'),
    )
    if allow_legacy:
        mismatches=[field for field in mismatches if not (
            (field=='experiment' and manifest.get('experiment') is None) or
            (field=='look' and manifest.get('look') is None)
        )]
    require(not mismatches,f'{path}: profile contract mismatches: {mismatches}')
    if 'config_sha256' in manifest:
        require(config_hash(manifest)==manifest['config_sha256'],f'{path}: manifest config hash')
    for side in 'ab':
        meta=manifest[f'engine_{side}_executable']
        require(meta.get('sha256')==profile['binary'],f'{path}: {side} declared binary SHA')
        exe=Path(manifest[f'engine_{side}_command'])
        require(exe.is_file() and sha(exe)==profile['binary'],f'{path}: {side} actual binary SHA')
        if profile.get('binary_path'):
            require(exe.resolve()==Path(profile['binary_path']).resolve(),f'{path}: {side} binary path differs from preregistration')
    openings={}
    for line in TSV.read_text().splitlines()[1:]:
        oid,source,prefix=line.split('\t');openings[oid]=(source,prefix.split())
    expected={f'round-{r:02d}/{oid}/A-{color}' for r in rounds for oid in openings for color in ('red','black')}
    actual=[g['game_id'] for g in games]
    require(len(openings)==50 and set(actual)==expected and len(set(actual))==200,f'{path}: ID coverage')
    replay_input=[]
    for g in games:
        gid=g['game_id'];oid=g['opening_id']
        if oid not in openings: errors.append(f'{gid}: unknown opening');continue
        source,prefix=openings[oid];seq=g['moves'];extra=seq[len(prefix):]
        require(g['source']==source and g['prefix']==prefix and seq[:len(prefix)]==prefix,f'{gid}: source/prefix')
        require(g['global_round'] in rounds and gid==f"round-{g['global_round']:02d}/{oid}/A-{'red' if g['a_is_red'] else 'black'}",f'{gid}: ID/color')
        require(g['nodes']==10000 and g['max_ply']==4096 and g['master_seed']==1,f'{gid}: row config')
        require(not g['protocol_error'] and not g['unfinished_reason'] and g['terminal_outcome'] in ('red','black','draw'),f'{gid}: terminal')
        require(g['result_for_a'] in ('win','draw','loss') and len(extra)<4096,f'{gid}: result/maxply')
        require(any(f"info string outcome {g['terminal_outcome']}" in line for line in g['terminal_raw']) and any('bestmove 0000' in line for line in g['terminal_raw']),f'{gid}: terminal raw')
        require(len(g['decision_seeds'])==len(extra)+1 and g['seed']==seed(1,gid,0),f'{gid}: seed count')
        for i in range(len(extra)+1):
            require(g['decision_seeds'][i]==seed(1,gid,i),f'{gid}: decision seed {i}')
        replay_input.append(gid+'\t'+' '.join(seq)+'\n')
    try:
        raw_audit=audit_raw_traces(path,games,list(openings),manifest_path=mpath,
                                   configured_raw_paths=configured_run.get('raw_log_paths'))
    except (OSError,KeyError,TypeError,ValueError,json.JSONDecodeError) as error:
        errors.append(f'{path}: raw trace audit failed: {error}')
        raw_audit={'raw_files':[],'decisions_by_actor':{'A':0,'B':0}}
    p=subprocess.run([str(REPLAY)],input=''.join(replay_input),text=True,capture_output=True)
    require(p.returncode==0,f'{path}: Game replay failed {p.stderr[-300:]}')
    replay={}
    if p.returncode==0:
        for line in p.stdout.splitlines():
            gid,outcome,ply=line.split('\t');replay[gid]=(outcome,int(ply))
    require(len(replay)==200,f'{path}: replay count')
    wdl=collections.Counter();bykey={}
    for g in games:
        gid=g['game_id']
        if gid not in replay:continue
        outcome,ply=replay[gid]
        require(outcome==g['terminal_outcome'] and ply==len(g['moves']),f'{gid}: Game adjudication')
        result='draw' if outcome=='draw' else ('win' if (outcome=='red')==g['a_is_red'] else 'loss')
        require(result==g['result_for_a'],f'{gid}: WDL')
        require(g['winner']==(None if result=='draw' else 'A' if result=='win' else 'B'),f'{gid}: winner')
        wdl[result]+=1
        bykey[(g['opening_id'],g['a_is_red'],g['global_round'])]=(tuple(g['moves']),outcome,result)
    summary=json.loads(spath.read_text())
    require(all(summary['wdl_for_a'][k]==wdl[k] for k in ('win','draw','loss')) and summary['finished_games']==200 and summary['unfinished_games']==0,f'{path}: summary WDL/completion')
    artifacts={
        'run-manifest.json':sha(mpath),
        'games.jsonl':sha(gpath),
        'summary.json':sha(spath),
    }
    artifacts['raw_files']=raw_audit['raw_files']
    return {'manifest':manifest,'games':games,'wdl':dict(wdl),'bykey':bykey,'summary':summary,'artifacts':artifacts,'raw_decisions':raw_audit['decisions_by_actor']}

def _audit_configured_batch(config):
    global TSV, REPLAY
    inputs=config['inputs'];run=config['run']
    TSV=Path(inputs['openings_tsv']['path'])
    REPLAY=Path(inputs['replay_executable']['path'])
    profile={
        'binary':config['binary']['sha256'],
        'binary_path':config['binary']['path'],
        'experiment':'q-capture-order',
        'options':(config['engine_a_options'],config['engine_b_options']),
        'workers':4,
        'runner_source_sha256':config['runner']['source_sha256'],
        'inputs':inputs,
    }
    batch=audit_batch(Path(run['output_dir']),profile,tuple(config['global_rounds']),configured_run=run)
    if errors:
        raise ValueError('; '.join(errors))
    return batch

def _selection_check(config):
    protocol_path=Path(config['inputs']['selection_protocol']['path'])
    protocol=json.loads(protocol_path.read_text(encoding='utf-8'))
    for label,key in (('eligible_population','eligible_population_path'),('selected_population','selected_population_path')):
        expected=Path(config['inputs'][label]['path']).resolve()
        referenced=(protocol_path.parent/protocol[key]).resolve()
        if expected!=referenced:
            raise ValueError(f'selection protocol {label} path differs from preregistration')
        if file_sha256(expected)!=config['inputs'][label]['sha256']:
            raise ValueError(f'selection protocol {label} SHA-256 mismatch')
    if protocol.get('eligible_population_sha256')!=config['inputs']['eligible_population']['sha256']:
        raise ValueError('selection protocol eligible population digest mismatch')
    if protocol.get('selected_population_sha256')!=config['inputs']['selected_population']['sha256']:
        raise ValueError('selection protocol selected population digest mismatch')
    if protocol.get('runner_tsv_sha256')!=config['inputs']['openings_tsv']['sha256']:
        raise ValueError('selection protocol openings TSV digest mismatch')
    eligible=read_jsonl(Path(config['inputs']['eligible_population']['path']))
    selected=read_jsonl(Path(config['inputs']['selected_population']['path']))
    sampled=random.Random(protocol['sampling_seed_u64']).sample(sorted(eligible,key=lambda row:row['position_key']),50)
    identity=lambda row:(row['opening_id'],row['position_key'],row['source_pgn_url'],row['iccs_prefix'])
    if len(eligible)!=203 or len(selected)!=50 or [identity(x) for x in sampled]!=[identity(x) for x in selected]:
        raise ValueError('frozen 203-to-50 opening sample does not reproduce')
    runner_path=Path(config['runner']['source_path'])
    spec=importlib.util.spec_from_file_location('m4_locked_runner',runner_path)
    if spec is None or spec.loader is None:
        raise ValueError('cannot load configured frozen match runner')
    runner=importlib.util.module_from_spec(spec)
    sys.modules[spec.name]=runner
    spec.loader.exec_module(runner)
    verified=runner.verify_selection_protocol(protocol_path,Path(config['inputs']['openings_tsv']['path']))
    if verified.get('full_selected_sample') is not True or verified.get('input_count')!=50:
        raise ValueError('configured runner did not verify the complete frozen opening sample')
    return {'population_size':203,'selected_count':50,'full_selected_sample':True}

def _write_result(config,result):
    target=Path(config['run']['audit_result_path'])
    if target.exists():
        raise ValueError(f'configured audit result path already exists: {target}')
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    return file_sha256(target)

def main():
    parser=argparse.ArgumentParser(description='Audit one preregistered QCaptureOrder batch and its paired look.')
    parser.add_argument('--preregistration',type=Path,required=True)
    args=parser.parse_args()
    try:
        config=json.loads(args.preregistration.read_text(encoding='utf-8'))
        validate_preregistration(config)
        evidence=read_run_evidence(config)
        selection=_selection_check(config)
        current=_audit_configured_batch(config)
        batches=[current]
        prior=None
        if config['look']==2:
            prior_ref=config['prior_look']
            prior_config=json.loads(Path(prior_ref['preregistration_path']).read_text(encoding='utf-8'))
            validate_preregistration(prior_config)
            _selection_check(prior_config)
            prior_evidence=read_run_evidence(prior_config)
            prior=_audit_configured_batch(prior_config)
            batches=[prior,current]
        bykey={};wdl=collections.Counter()
        for batch in batches:
            bykey.update(batch['bykey']);wdl.update(batch['wdl'])
        rounds=(1,2) if config['look']==1 else (1,2,3,4)
        repeats=[]
        opening_ids=[line.split('\t')[0] for line in TSV.read_text(encoding='utf-8').splitlines()[1:]]
        for oid in opening_ids:
            for color in (True,False):
                first=bykey.get((oid,color,1))
                for rnd in rounds:
                    value=bykey.get((oid,color,rnd))
                    if value is None: errors.append(f'missing {oid}/{color}/{rnd}')
                    elif value!=first: repeats.append((oid,color,rnd))
        stats=calculate_cluster_statistics(bykey,rounds)
        verdict=decision_verdict(stats['decision_97_5_score_interval'],config['look']==2)
        if config['look']==1 and verdict=='revert_after_second_look':
            verdict='second_look'
        if repeats:
            errors.append(f'rounds are not deterministic: {repeats[:4]}')
        result={
            'classification':'preregistered q-capture-order audit',
            'formal_ready':not errors and evidence['exit_status'].get('exit_code')==0 and selection['full_selected_sample'],
            'preregistration_path':str(args.preregistration.resolve()),
            'preregistration_sha256':file_sha256(args.preregistration),
            'look':config['look'],'total_games':sum(sum(batch['wdl'].values()) for batch in batches),
            'replayed_games':sum(len(batch['bykey']) for batch in batches),
            'wdl_for_a':dict(wdl),'opening_clusters':stats['cluster_count'],
            'score':stats['score_mean'],'report_95_ordinary_hoeffding':stats['report_95_hoeffding_score_interval'],
            'decision_97_5_finite_serfling':stats['decision_97_5_score_interval'],
            'repeat_mismatches':repeats,'verdict':verdict,'batch_artifacts':[b['artifacts'] for b in batches],
            'raw_decisions':[b['raw_decisions'] for b in batches],
            'current_run_evidence':evidence,'selection':selection,'errors':errors,
        }
        if not result['formal_ready']:
            result['verdict']='invalid'
        result['audit_result_sha256']=_write_result(config,result)
        print(json.dumps(result,indent=2,ensure_ascii=False))
        raise SystemExit(0 if result['formal_ready'] else 1)
    except (OSError,KeyError,TypeError,ValueError,json.JSONDecodeError) as error:
        print(json.dumps({'formal_ready':False,'verdict':'invalid','errors':[str(error)]},indent=2,ensure_ascii=False))
        raise SystemExit(1)


if __name__=='__main__':
    main()
